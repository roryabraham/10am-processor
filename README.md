# 10am-processor
A command line tool for processing 10am updates. It will go through all your 10ams and attempt to link them to the correct project/cost center. To use this tool:

## Get the 10am data
1. Go to Chronos in Slack and type 10am export 2019-01-01
2. Copy and paste the URL link for your export file at the top of your notes
3. Click the link
4. Make sure every year is expanded
5. Select all, copy
6. Create a new text file and open it in a text editor
7. Paste in the 10am dump data
8. Save the text file

## Get the project data
1. To get the most up-to-date project information, go to the Projects & Chores tab of the Employee Allocation Spreadsheet
2. Press `File` => `Download` => `Comma-Separated Values (.csv, current sheet)`
3. Move the downloaded csv file to the root directory of this project.
4. Alternatively, use the `projectTab.csv` file that's currently in the root of this repository.

### Pro tip

To get much better results out of this tool:

1. Copy the `Projects & Chores Tab` of the Employee Allocation Spreadsheet into a new sheet
2. _In your separate copy_, do not edit any existing rows, but delete any rows containing projects that you know you didn't work on.
3. Then repeat steps 2 and 3 above (download the CSV file), and continue...

## Use the tool

If your 10am data is in the same root directory of this project in a file called `tenAMDump.txt`, you can simply use the following commands to run the tool:

```bash
npm install
node ./tenAMProcessor.js ./tenAMDump.txt ./projectTab.csv CoR >> output.txt
```

That will output the processed 10am data to a file called `output.txt`, which you can then paste into your Allocation Notes Google Doc. 
