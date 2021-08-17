#!/usr/bin/env node

const _ = require('underscore');
const {existsSync, readFileSync} = require('fs');
const { exit } = require('process');
const parseCSV = require('csv-parse/lib/sync');

const YEARS = ['2019', '2020', '2021'];
const MONTHS = [
    'January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December',
];
const MONTHS_3_DIGIT = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
const WEEKDAYS = ['MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY'];
const COST_CENTERS = {
    GA: 'G&A',
    RD: 'R&D',
    SM: 'S&M',
    COR: 'CoR',
};

function printUsage() {
    console.error('Must provide: (1) a 10am dump text file, (2) a project tab CSV, and (3) your home cost center:\n\tnode ./tenAMProcessor.js ./tenAMDump.txt ./projectTab.csv CoR');
    exit(1);
}

const tenAMFilename = process.argv[2];
if (typeof tenAMFilename !== 'string') {
    console.error('Error: must provide a filename for the 10am dump');
    printUsage();
}
if (!existsSync(tenAMFilename)) {
    console.error(`Error: ${tenAMFilename} not found`);
    printUsage();
}

const projectTabFilename = process.argv[3];
if (typeof projectTabFilename !== 'string') {
    console.error('Error: must provide a filename for the project tab csv');
    printUsage();
}
if (projectTabFilename.substr(-4) !== '.csv') {
    console.error('Error: project tab file must be a .csv');
    printUsage();
}
if (!existsSync(projectTabFilename)) {
    console.error(`Error: ${projectTabFilename} not found`);
    printUsage();
}

const homeCostCenter = process.argv[4];
if (!_.contains(_.values(COST_CENTERS), homeCostCenter)) {
    console.error(`Error: Must provide a home cost center. Must be one of: [${_.values(COST_CENTERS).join(', ')}]`);
    printUsage();
}

// First, parse 10am data
const dump10am = readFileSync(tenAMFilename).toString();
const annualData = _.reduce(
    dump10am.split(new RegExp(`(${YEARS.join('|')})\n`)),
    (acc, datum) => {
        if (datum) {
            if (YEARS.includes(datum)) {
                acc[datum] = '';
            } else {
                for (let year of YEARS) {
                    if (acc.hasOwnProperty(year)) {
                        acc[year] += datum;
                        break;
                    }
                }
            }
        }
        return acc;
    },
    {},
);
const monthlyData = _.reduce(
    Object.entries(annualData),
    (acc, [year, data]) => {
        if (!_.has(acc, year)) {
            acc[year] = {};
        }
        _.each(
            data.split(new RegExp(`(${MONTHS.join('|')})\n`)),
            datum => {
                if (datum) {
                    if (_.contains(MONTHS, datum)) {
                        acc[year][datum] = '';
                    } else {
                        for (let month of MONTHS) {
                            if (_.has(acc[year], month)) {
                                acc[year][month] += datum;
                                break;
                            }
                        }
                    }
                }
            }
        )
        return acc;
    },
    {}
);

/**
 * Shape:
 * {
 *     2020: {
 *         january: [
 *             [// tenAM items for one day],
 *             [// tenAM items for the next day],
 *             ...
 *         ]
 *         february: [...],
 *     },
 *     2021: {...}
 * }
 * @type {Object}
 */
const tenAMs = _.mapObject(
    monthlyData,
    monthData => _.mapObject(
        monthData,
        tenAMData => {
            const tenAMUpdates = _.compact(tenAMData.split(new RegExp(`(?:${MONTHS_3_DIGIT.join('|')}) (\\d+(?:ST|ND|RD|TH)) \\d+ (${WEEKDAYS.join('|')})`)));
            return _.map(
                _.chunk(tenAMUpdates, 3),
                chunk => ({
                    date: chunk[0],
                    weekday: chunk[1],
                    content: chunk[2].trim().split('\n')
                })
            );
        }
    ),
);
// const tenAMs = _.mapObject(monthlyData,(monthData, year) => _.mapObject(monthData, (tenAMData) => (
//     _.chain(tenAMData.split(new RegExp(`(?:${MONTHS_3_DIGIT.join('|')}) \\d+(?:ST|ND|RD|TH) \\d+ (?:${WEEKDAYS.join('|')})`)))
//         .filter(item => Boolean(item))
//         .map(item => item.trim().split('\n'))
//         .value()
// )));

// Next, parse project tab csv data
let projectTabData = _.map(
    parseCSV(
        readFileSync(projectTabFilename), {
            columns: true,
            skipEmptyLines: true,
        }
    ),
    record => _.reduce(
        record,
        (memo, value, key) => {
            // Rename columns and pick out the data we want
            switch (key) {
                case 'Project (PLEASE DON\'T CHANGE PROJECT NAMES ONCE THEY\'RE IN HERE. Add them to Aliases)':
                    return {...memo, project: value};
                case 'Project Aliases':
                    return {
                        ...memo,
                        aliases: _.chain(value.split(','))
                            .map(value => value.trim())
                            .compact()
                            .value(),
                    };
                case 'Cost Center':
                    return {...memo, costCenter: value};
                default:
                    return memo;
            }
        },
        {}),
);

// Next, transform the 10am data to tag the correct projects
const processedTenAMs = _.mapObject(tenAMs, monthTenAMs => (
    _.mapObject(monthTenAMs, tenAMUpdates => {
        const costCenterCounts = {
            [COST_CENTERS.RD]: 0,
            [COST_CENTERS.GA]: 0,
            [COST_CENTERS.SM]: 0,
            [COST_CENTERS.COR]: 0,
        };
        const subProcessedMonthTenAMs = _.mapObject(tenAMUpdates, tenAMUpdate => ({
            date: tenAMUpdate.date,
            weekday: tenAMUpdate.weekday,
            content: _.map(tenAMUpdate.content, tenAMItem => {
                for (let project of projectTabData) {
                    if (project.costCenter !== homeCostCenter) {
                        for (let keyword of [project.project, ...project.aliases]) {
                            if (tenAMItem.includes(keyword)) {
                                return `${tenAMItem} [${project.costCenter} ${++costCenterCounts[project.costCenter]}/? – ${project.project}]`;
                            }
                        }
                    }
                }
                return tenAMItem;
            })
        }));
        return _.mapObject(subProcessedMonthTenAMs, tenAMUpdate => ({
            date: tenAMUpdate.date,
            weekday: tenAMUpdate.weekday,
            content: _.map(tenAMUpdate.content, tenAMItem => tenAMItem.replace(
                new RegExp(`(${_.values(COST_CENTERS).join('|')}) (\\d+)/\\?`),
                (_, matchedCostCenter, unitCount) => `${matchedCostCenter} ${unitCount}/${costCenterCounts[matchedCostCenter]}`,
            ))
        }));
    })
));

// Output results
_.each(processedTenAMs, (yearData, year) => {
    console.log(year);
    _.each(yearData, (monthData, month) => {
        console.log(month);
        _.each(monthData, tenAMUpdate => {
            console.log(`${tenAMUpdate.weekday} ${tenAMUpdate.date} ${month} ${year}`)
            _.each(tenAMUpdate.content, tenAMItem => {
                console.log(tenAMItem);
            })
            console.log();
        })
        console.log();
    })
    console.log('\n');
});
