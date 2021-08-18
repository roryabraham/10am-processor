#!/usr/bin/env node

const _ = require('underscore');
const { exit } = require('process');
const moment = require('moment-timezone');
const {Octokit} = require('@octokit/rest');
const {throttling} = require('@octokit/plugin-throttling');

const argv = require('yargs/yargs')(process.argv.slice(2)).argv;

function printUsage () {
    console.error('Invalid usage – Must provide a GitHub token and a date. Example:\n\t./getGitHubContributions.js --token=XXX --date=2021-01-01');
    exit(1);
}

if (_.isEmpty(argv.token)) {
    console.error('Error: No GitHub token provided');
    printUsage();
}

if (_.isEmpty(argv.date)) {
    console.error('Error: No date provided');
    printUsage();
}

if (!moment(argv.date).isValid()) {
    console.error('Error: Invalid date');
    printUsage();
}

// Adjust date for timezone for GitHub
const GITHUB_TIMEZONE_FORMAT = 'YYYY-MM-DDTHH:mm:ssZ';
const startDate = moment.tz(`${argv.date} 00:00:00`, 'America/Los_Angeles')
    .format(GITHUB_TIMEZONE_FORMAT);
const endDate = moment.tz(`${argv.date} 23:59:59`, 'America/Los_Angeles')
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
                q: `org:Expensify commenter:${username} updated:${startDate}..${endDate}`,
            }),
            octokit.paginate(octokit.search.commits, {
                q: `org:Expensify author:${username} author-date:${startDate}..${endDate}`,
            }),
        ]))
        .then(([
            issuesAndPullRequestsCreated,
            issuesAndPullRequestsCommented,
            commits,
        ]) => {
            return Promise.all(
                _.map(
                    issuesAndPullRequestsCommented,
                    issue => octokit.paginate(`GET ${issue.comments_url.slice('https://api.github.com'.length)}`))
            )
                .then(comments => _.filter(_.flatten(comments), comment => comment.user.login === username))
                .then(comments => ({
                    issues: issuesAndPullRequestsCreated,
                    comments,
                    commits,
                }));
        })
        .catch((e) => {
            console.error('Error: Unexpected GitHub API error –', e);
            printUsage();
        });
}

// Format date to match 10am output
const outputDate = moment(argv.date).format('MMM Do YYYY dddd').toUpperCase();
getGitHubData()
    .then(({issues, commits, comments}) => {
        let output = `\n${outputDate} [Note: GH Activity]\n`;
        _.each(issues, issue => output += `• GH: [${issue.pull_request ? 'PR' : 'Issue'} #${issue.number}](${issue.html_url}) – ${issue.title}\n`)
        output += `• GH: Commits – [\n\t• ${_.pluck(commits, 'html_url').join('\n\t• ')}\n  ]\n`;
        output += `• GH: Comments – [\n\t• ${_.pluck(comments, 'html_url').join('\n\t• ')}\n  ]\n`;
        console.log(output);
    });
