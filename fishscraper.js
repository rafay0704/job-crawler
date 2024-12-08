const puppeteer = require('puppeteer');
const fs = require('fs');
const mysql = require('mysql2');

// MySQL database connection
const db = mysql.createConnection({
  host: 'localhost',
  user: 'root',
  password: 'admin',
  database: 'job_scraper',
});

// Function to check if job already exists in the database
async function jobExistsInDB(jobLink) {
  const sql = `SELECT * FROM unsolicited_job_post WHERE original_job_link = ?`;
  
  return new Promise((resolve, reject) => {
    db.query(sql, [jobLink], (err, result) => {
      if (err) {
        reject(`Error checking job existence in database: ${err}`);
      } else {
        resolve(result.length > 0); // If result length is greater than 0, the job exists
      }
    });
  });
}

// Function to store job data in the database
async function storeJobInDB(job, jobTitle) {
  const sql = `
    INSERT INTO unsolicited_job_post (websites_id, title, address, country, skills, job_details, category_name, original_job_link, job_posted, created_on)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())`;

  const values = [
    12, // Assuming website ID is 12 for Fish4 jobs
    job.title,
    job.location,
    job.salary,
    job.recruiter,
    job.description,
    jobTitle,
    job.link,
    'Yes', // Assuming 'Yes' for now; adjust according to actual status
  ];

  // Check if the job already exists before inserting
  const exists = await jobExistsInDB(job.link);
  if (exists) {
    console.log(`Job already exists in the database: ${job.title}`);
    return; // Skip saving this job if it already exists
  }

  return new Promise((resolve, reject) => {
    db.query(sql, values, (err, result) => {
      if (err) {
        reject(`Error saving job to database: ${err}`);
      } else {
        resolve(result);
      }
    });
  });
}

// Function to scrape jobs dynamically
async function scrapeJobs(jobTitle, browser) {
  const page = await browser.newPage();
  const url = 'https://www.fish4.co.uk/';

  try {
    console.log(`Navigating to ${url} for ${jobTitle}...`);
    await page.goto(url, { waitUntil: 'networkidle0', timeout: 180000 });

    // Accept cookies
    await page.waitForSelector('#CybotCookiebotDialogBodyLevelButtonLevelOptinAllowAll', { visible: true, timeout: 10000 });
    await page.click('#CybotCookiebotDialogBodyLevelButtonLevelOptinAllowAll');
    console.log(`Accepted cookies for ${jobTitle}`);

    // Search for jobs
    console.log(`Searching for jobs: ${jobTitle}`);
    await page.type('#keywords', jobTitle);
    await page.keyboard.press('Enter');
    await page.waitForNavigation({ waitUntil: 'networkidle0', timeout: 180000 });

    let currentPage = 1;
    let jobs = [];

    // Loop through pages until no "Next" button is found
    while (true) {
      console.log(`Scraping page ${currentPage} for ${jobTitle}...`);

      // Wait for the job listing section to load
      await page.waitForSelector('.lister__item', { visible: true, timeout: 60000 });

      // Extract job details from the current page
      const newJobs = await page.evaluate(() => {
        const jobCards = Array.from(document.querySelectorAll('.lister__item'));
        return jobCards.map((job) => ({
          title: job.querySelector('.lister__header a span')?.innerText.trim() || 'No Title',
          location: job.querySelector('.lister__meta-item--location')?.innerText.trim() || 'No Location',
          salary: job.querySelector('.lister__meta-item--salary')?.innerText.trim() || 'No Salary',
          recruiter: job.querySelector('.lister__meta-item--recruiter')?.innerText.trim() || 'No Recruiter',
          description: job.querySelector('.lister__description')?.innerText.trim() || 'No Description',
          link: job.querySelector('.lister__header a')?.href || 'No Link',
          date: job.querySelector('.job-actions__action')?.innerText.trim() || 'No Date Posted',
        }));
      });

      jobs = [...jobs, ...newJobs]; // Add the newly fetched jobs to the main list

      // Save jobs to JSON after every page
      let existingJobs = [];
      try {
        const data = fs.readFileSync('fish4jobs.json', 'utf-8');
        existingJobs = JSON.parse(data);
      } catch (err) {
        console.log('No existing jobs file found, starting fresh...');
      }

      // Filter out already existing jobs
      const jobsToSave = jobs.filter((newJob) => {
        return !existingJobs.some((existingJob) => existingJob.link === newJob.link);
      });

      console.log(`Found ${jobsToSave.length} new unique jobs for ${jobTitle}.`);

      // Append new jobs to the existing list
      existingJobs = [...existingJobs, ...jobsToSave];

      // Save the updated jobs list to the JSON file after each page
      fs.writeFileSync('fish4jobs.json', JSON.stringify(existingJobs, null, 2));
      console.log(`Jobs saved to fish4jobs.json after page ${currentPage} for ${jobTitle}`);

      // Insert new jobs into the database
      for (const job of jobsToSave) {
        await storeJobInDB(job, jobTitle);
        console.log(`Job saved to database: ${job.title}`);
      }

      // Check if the "Next" button exists and navigate to the next page
      const nextButton = await page.$('.paginator__item a[rel="next"]');
      if (nextButton) {
        const nextPageUrl = await page.evaluate(el => el.href, nextButton);
        console.log(`Going to next page: ${nextPageUrl}`);
        await page.goto(nextPageUrl, { waitUntil: 'networkidle0', timeout: 120000 });
        currentPage++;
      } else {
        break; // No next page, exit loop
      }
    }

    console.log(`Fetched ${jobs.length} jobs for ${jobTitle}.`);
  } catch (error) {
    console.error(`Error during scraping for ${jobTitle}:`, error);
  } finally {
    await page.close();
  }
}

// List of job positions to scrape (can be dynamically configured or loaded from an external source)
const jobTitles = [
  'Software Developer',
  'Project Manager',
  'Data Analyst',
  'Software Tester',
];

// Run the scraper for all job titles concurrently
async function run() {
  const browser = await puppeteer.launch({ headless: false, slowMo: 250 }); // Launch browser with slow motion for better debug visibility

  // Start scraping for all job titles in parallel
  const promises = jobTitles.map(jobTitle => scrapeJobs(jobTitle, browser));

  // Wait for all scraping tasks to complete
  await Promise.all(promises);

  // Close the browser after all jobs are scraped
  await browser.close();
}

// Start the scraping process
run();
