#!/usr/bin/env node

const _ = require('underscore');
const { exit } = require('process');
const moment = require('moment-timezone');
const {Octokit} = require('@octokit/rest');
const {throttling} = require('@octokit/plugin-throttling');
const yargs = require('yargs');
const DateUtils = require('./dateUtils');

const argv = yargs
    .options({
        'token': {type: 'string', alias: 't', demandOption: true, describe: 'GitHub Personal Access Token (PAT)'},
        'date': {type: 'string', alias: 'd', describe: 'Specific date to find data for', conflicts: ['startDate', 'endDate']},
        'startDate': {type: 'string', describe: 'Beginning of date range to find data for', implies: 'endDate', conflicts: 'date'},
        'endDate': {type: 'string', describe: 'End of date range to find data for', implies: 'startDate', conflicts: 'date'},
    })
    .check((argv) => {
        _.each(_.pick(argv, ['date', 'startDate', 'endDate']), (date, option) => {
            if (!moment(date).isValid()) {
                throw new Error(`Error: ${option} ${date} is not a valid date`);
            }
        })

        if (!_.isEmpty(argv.startDate) && !_.isEmpty(argv.endDate) && moment(argv.startDate).isAfter(argv.endDate)) {
            throw new Error(`Error: startDate ${argv.startDate} is after endDate ${argv.endDate}`);
        }

        return true;
    }).argv;

// Adjust date for timezone for GitHub
const GITHUB_TIMEZONE_FORMAT = 'YYYY-MM-DDTHH:mm:ssZ';
const startDate = moment.tz(`${argv.startDate ?? argv.date} 00:00:00`, 'America/Los_Angeles')
    .format(GITHUB_TIMEZONE_FORMAT);
const endDate = moment.tz(`${argv.endDate ?? argv.date} 23:59:59`, 'America/Los_Angeles')
    .format(GITHUB_TIMEZONE_FORMAT);
const twoWeeksBefore = moment.tz(`${argv.startDate ?? argv.date} 00:00:00`, 'America/Los_Angeles')
    .subtract(14, 'days')
    .format(GITHUB_TIMEZONE_FORMAT);

// Setup Octokit
const OctokitThrottled = Octokit.plugin(throttling);
const octokit = new OctokitThrottled({
    auth: argv.token,
    throttle: {
        onRateLimit: (retryAfter, options) => {
            // Retry once after hitting a rate limit error, then give up
            if (options.request.retryCount <= 1) {
                return true;
            }
        },
        onAbuseLimit: (retryAfter, options) => {
            // does not retry, only logs a warning
            console.error(`Abuse detected for request ${options.method} ${options.url}`,);
        },
    },
});

function getGitHubData() {
    let username;
    return octokit.users.getAuthenticated()
        .then(({data}) => username = data.login)
        .then(() => Promise.all([
            octokit.paginate(octokit.search.issuesAndPullRequests, {
                q: `org:Expensify author:${username} created:${startDate}..${endDate}`,
            }),
            octokit.paginate(octokit.search.issuesAndPullRequests, {
                q: `org:Expensify is:pr reviewed-by:${username} created:${twoWeeksBefore}..${endDate}`,
                per_page: 100,
            }),
            octokit.paginate(octokit.search.issuesAndPullRequests, {
                q: `org:Expensify commenter:${username} updated:${startDate}..${endDate}`,
            }),
            octokit.paginate(octokit.search.commits, {
                q: `org:Expensify author:${username} author-date:${startDate}..${endDate}`,
            }),
        ]))
        .then(([
            issuesAndPullRequestsCreated,
            reviewedPRs,
            issuesAndPullRequestsCommented,
            commits,
        ]) => {
            return Promise.all(_.map(
                issuesAndPullRequestsCommented,
                issue => octokit.paginate(`GET ${issue.comments_url.slice('https://api.github.com'.length)}`))
            )
                .then(comments => _.filter(_.flatten(comments), comment => comment.user.login === username))
                .then(comments => ({
                    issues: issuesAndPullRequestsCreated,
                    reviewedPRs: _.filter(reviewedPRs, reviewedPR => reviewedPR.user.login !== username),
                    comments,
                    commits,
                }));
        })
        .then(({
            issues,
            reviewedPRs,
            comments,
            commits,
        }) => Promise.all(_.map(
                    reviewedPRs,
                    reviewedPR => octokit.paginate(
                        `GET ${reviewedPR.url.slice('https://api.github.com'.length)}/timeline`,
                        {headers: {Accept: 'application/vnd.github.mockingbird-preview'}}
                    )
                ))
                .then(events => _.filter(events, event => event.event === 'reviewed' && event.user.login === username))
                .then(reviews => ({
                    issues,
                    reviews,
                    comments,
                    commits,
                }))
        )
        .then(({
            issues,
            reviews,
            comments,
            commits,
        }) => Promise.all(_.map(
                commits,
                commit => octokit.repos.listPullRequestsAssociatedWithCommit({
                    owner: 'Expensify',
                    repo: commit.repository.name,
                    commit_sha: commit.sha,
                })
                    .then(({data}) => ({
                        ...commit,
                        associatedPullRequests: _.filter(data, pr => pr.user.login === username),
                    }))
            ))
            .then(commitsWithAssociatedPullRequests => ({
                issues,
                reviews,
                comments,
                commits: _.filter(commitsWithAssociatedPullRequests, commit => !_.isEmpty(commit.associatedPullRequests)),
            }))
        )
        .then(({
            issues,
            reviews,
            comments,
            commits,
        }) => {
            const fullDataSet = _.chain([
                startDate,
                ...DateUtils.enumerateDaysBetweenDates(startDate, endDate),
                endDate,
            ])
                .flatten()
                .map(date => moment(date).format('YYYY-MM-DD'))
                .reduce((memo, date) => {
                    memo[date] = {
                        issues: [],
                        reviews: [],
                        comments: [],
                        commits: [],
                    }
                    return memo;
                }, {})
                .value();

            _.each(issues, (issue) => {
                _.each(fullDataSet, (dataForDate, distinctDate) => {
                    if (moment(issue.created_at).tz('America/Los_Angeles').isSame(distinctDate, 'day')) {
                        dataForDate.issues.push(issue);
                    }
                })
            })

            _.each(reviews, (review) => {
                _.each(fullDataSet, (dataForDate, distinctDate) => {
                    if (moment(review.submitted_at).tz('America/Los_Angeles').isSame(distinctDate, 'day')) {
                        dataForDate.reviews.push(review);
                    }
                })
            })

            _.each(comments, (comment) => {
                _.each(fullDataSet, (dataForDate, distinctDate) => {
                    if (moment(comment.created_at).tz('America/Los_Angeles').isSame(distinctDate, 'day')) {
                        dataForDate.comments.push(comment);
                    }
                })
            })

            _.each(commits, (commit) => {
                _.each(fullDataSet, (dataForDate, distinctDate) => {
                    if (moment(commit.commit.author.date).tz('America/Los_Angeles').isSame(distinctDate, 'day')) {
                        dataForDate.commits.push(commit);
                    }
                })
            })

            return fullDataSet;
        })
        .catch((e) => {
            console.error('Error: Unexpected GitHub API error –', e);
            exit(1);
        });
}

getGitHubData()
    .then((dataset) => {
        let output = '';
        _.each(dataset, ({issues, reviews, comments, commits}, date) => {
            const outputDate = moment(date).format('MMM Do YYYY').toUpperCase();
            output += `\n${outputDate} [Note: GH Activity]\n`;
            _.each(issues, issue => output += `• GH: Created [${issue.pull_request ? 'PR' : 'Issue'} #${issue.number}](${issue.html_url}) – ${issue.title}\n`);

            const updatedPRsWithCommits = _.chain(commits)
                .reduce(
                    (memo, commit) => {
                        _.each(commit.associatedPullRequests, pr => {
                            if (!_.has(memo, pr.number)) {
                                memo[pr.number] = {
                                    url: pr.html_url,
                                    commits: [commit],
                                }
                            } else {
                                memo[pr.number].commits.push(commit);
                            }
                        })
                        return memo;
                    },
                    {},
                )
                .omit(_.pluck(issues, 'number'))
                .value();

            _.each(updatedPRsWithCommits, (prWithCommits, prNumber) => {
                output += `• GH: Updated PR #${prNumber} with the following commits: [\n\t• ${_.pluck(prWithCommits.commits, 'html_url').join('\n\t• ')}\n  ]\n`;
            });

            _.each(reviews, review => output += `• GH: [Reviewed PR #${review.pull_request_url.split('/').pop()}](${review.html_url})`);
            if (!_.isEmpty(comments)) {
                output += `• GH: Comments – [\n\t• ${_.pluck(comments, 'html_url').join('\n\t• ')}\n  ]\n`;
            }
        });
        console.log(output);
    });
