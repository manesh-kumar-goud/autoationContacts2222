const express = require('express');
const puppeteer = require('puppeteer');
const { createClient } = require('@supabase/supabase-js');
const winston = require('winston');
const cors = require('cors');
const helmet = require('helmet');
const compression = require('compression');
require('dotenv').config();


const userAgents = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4.1 Safari/605.1.15',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:125.0) Gecko/20100101 Firefox/125.0'
];

// Initialize Express app
const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(helmet());
app.use(compression());
app.use(cors());
app.use(express.json());

// Logger
const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(winston.format.timestamp(), winston.format.json()),
  transports: [
    new winston.transports.File({ filename: 'error.log', level: 'error' }),
    new winston.transports.File({ filename: 'combined.log' }),
    new winston.transports.Console({ format: winston.format.simple() })
  ]
});

// Supabase Client
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

// Global State
let isProcessing = false;

// Puppeteer setup
async function setupBrowser() {
  try {
    const browser = await puppeteer.launch({
      headless: "new",
      args: [
        '--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage',
        '--disable-gpu', '--disable-infobars', '--window-size=1920,1080',
        '--no-zygote', '--single-process'
      ]
    });
    logger.info('Browser setup completed');
    return browser;
  } catch (error) {
    logger.error('Browser setup failed:', error);
    throw error;
  }
}

// Scraper for service details
async function fetchServiceDetails(page, circleCode, serviceNumber) {
    try {
        await page.goto('https://tgsouthernpower.org/getUkscno', { waitUntil: 'domcontentloaded', timeout: 30000 });
        await page.waitForSelector('#ukscno', { timeout: 15000 });
        await page.type('#ukscno', `${circleCode} ${serviceNumber}`, { delay: 0 });
        await Promise.all([
            page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 25000 }).catch(() => null),
            page.click('button[type="submit"]')
        ]);
        await page.waitForSelector('table', { timeout: 10000 }).catch(() => null);

        const serviceDetails = await page.evaluate((cCode, sNum) => {
            const rows = document.querySelectorAll('table tr');
            for (const row of rows) {
                const cells = row.querySelectorAll('td');
                if (cells.length >= 6) {
                    return {
                        serviceNo: cells[0]?.textContent?.trim() || `${cCode} ${sNum}`,
                        uniqueServiceNo: cells[1]?.textContent?.trim() || 'Not Found',
                        customerName: cells[2]?.textContent?.trim() || 'Not Found',
                        address: cells[3]?.textContent?.trim() || 'Not Found',
                        ero: cells[4]?.textContent?.trim() || 'Not Found',
                        mobile: cells[5]?.textContent?.trim() || 'Not Found',
                        status: 'Success'
                    };
                }
            }
            return { status: 'Failed' };
        }, circleCode, serviceNumber);
        
        if (serviceDetails.status !== 'Success') {
            serviceDetails.serviceNo = `${circleCode} ${serviceNumber}`;
        }
        return serviceDetails;
    } catch (error) {
        logger.error(`Fetch Details Error for ${circleCode}-${serviceNumber}: ${error.message}`);
        return { serviceNo: `${circleCode} ${serviceNumber}`, status: 'Failed' };
    }
}

// Scraper for bill amount with retry logic
async function fetchBillAmount(page, ukscno) {
  if (!ukscno || ukscno === 'Not Found') {
    return 'Not Found';
  }

  const MAX_RETRIES = 3;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      await page.goto('https://tgsouthernpower.org/getBillAmount', { waitUntil: 'domcontentloaded', timeout: 45000 });
      await page.waitForSelector('#ukscno', { timeout: 20000 });
      await page.type('#ukscno', ukscno, { delay: 20 });
      await Promise.all([
        page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => null),
        page.click('button[type="submit"]')
      ]);
      await page.waitForNetworkIdle({ idleTime: 500, timeout: 15000 }).catch(() => {});
      await page.waitForSelector('table tr:nth-child(2)', { timeout: 10000 }).catch(() => {});

      const billAmount = await page.evaluate(() => {
        const norm = (s) => (s || '').replace(/\s+/g, ' ').trim().toLowerCase();
        const rows = document.querySelectorAll('table tr');
        for (const row of rows) {
            const cells = row.querySelectorAll('td, th');
            if (cells.length > 1) {
                for (let i = 0; i < cells.length - 1; i++) {
                    const labelText = norm(cells[i].textContent);
                    if (labelText.includes('current month bill') || labelText.includes('total amount payable')) {
                        const amountText = cells[cells.length - 1].textContent.trim();
                        if (amountText && amountText.match(/([0-9,]+\.?[0-9]*)/)) {
                            return amountText;
                        }
                    }
                }
            }
        }
        return 'Not Found';
      });

      if (billAmount && billAmount !== 'Not Found') {
        return billAmount; // Success, exit retry loop
      }
      // If evaluate returns "Not Found", we might want to retry.
      if (attempt < MAX_RETRIES) {
          logger.warn(`Could not find bill amount for ${ukscno} on attempt ${attempt}. Retrying...`);
          await new Promise(resolve => setTimeout(resolve, 1500)); // Wait before retrying
      } else {
          return 'Not Found'; // Return "Not Found" after all retries
      }
    } catch (error) {
      logger.error(`Attempt ${attempt}/${MAX_RETRIES} failed for bill fetch ${ukscno}: ${error.message}`);
      if (attempt === MAX_RETRIES) {
        return 'Not Found'; // Return after the last retry fails
      }
      await new Promise(resolve => setTimeout(resolve, 2000 * attempt));
    }
  }
  return 'Not Found';
}

// Orchestrates a single lookup
async function processService(page, circleCode, serviceNumber) {
    const serviceDetails = await fetchServiceDetails(page, circleCode, serviceNumber);
    let billAmount = 'Not Found';
    if (serviceDetails.status === 'Success') {
        billAmount = await fetchBillAmount(page, serviceDetails.uniqueServiceNo);
    }
    return { ...serviceDetails, billAmount, processedAt: new Date().toISOString() };
}

// Saves data to the database
async function saveToSupabase(data) {
  try {
    if (process.env.SAVE_ONLY_SUCCESS === 'true' && data.status !== 'Success') {
      return true;
    }
    const { error } = await supabase.from('tgspdcl_automation_data').insert([{
      service_no: data.serviceNo, unique_service_no: data.uniqueServiceNo,
      customer_name: data.customerName, address: data.address, ero: data.ero,
      mobile: data.mobile, bill_amount: data.billAmount, fetch_status: data.status,
      status: 'COMPLETED', search_info: { processed_at: data.processedAt }
    }]);
    if (error) throw error;
    return true;
  } catch (error) {
    logger.error(`Supabase insert error: ${error.message}`);
    return false;
  }
}

// Gets the next available task
async function getNextPendingTask() {
  try {
    const { data, error } = await supabase.from('circle_codes').select('*').eq('status', 'PENDING').order('id', { ascending: true }).limit(1);
    if (error) throw error;
    return data?.[0] || null;
  } catch (error) {
    logger.error(`Error fetching next pending task: ${error.message}`);
    return null;
  }
}

// Updates the task status
async function updateCircleCodeStatus(id, status) {
  try {
    const { error } = await supabase.from('circle_codes').update({ status }).eq('id', id);
    if (error) throw error;
    return true;
  } catch (error) {
    logger.error(`Error updating circle status for ${id}: ${error.message}`);
    return false;
  }
}

// Processes one full circle code, reusing the provided browser
async function processCircleCode(circle, browser) {
  const { circle_code, digits_in_service_code, id } = circle;
  logger.info(`Processing circle code: ${circle_code} with ${digits_in_service_code} digits`);
  
  try {
    await updateCircleCodeStatus(id, 'PROCESSING');
    
    const maxNumber = Math.pow(10, digits_in_service_code) - 1;
    const startIndex = 0;
    const endIndex = maxNumber;
    logger.info(`Processing range: 00000 to ${'9'.repeat(digits_in_service_code)}`);
    
    let processedCount = 0, successCount = 0;
    for (let i = startIndex; i <= endIndex; i++) {
      const serviceNumber = i.toString().padStart(digits_in_service_code, '0');
      let page = null;
      try {
        page = await browser.newPage();
        await page.setDefaultNavigationTimeout(45000);
        await page.setViewport({ width: 1920, height: 1080 });
        await page.setUserAgent(userAgents[Math.floor(Math.random() * userAgents.length)]);
        await page.setRequestInterception(true);
        page.on('request', (req) => {
          ['image', 'stylesheet', 'font', 'media'].includes(req.resourceType()) ? req.abort() : req.continue();
        });
        
        const result = await processService(page, circle_code, serviceNumber);
        if(result.status === 'Success') {
            await saveToSupabase(result);
            successCount++;
        }
        processedCount++;

        if (processedCount % 20 === 0) {
          logger.info(`Progress: ${processedCount}/${endIndex+1} (${successCount} found) for circle ${circle_code}`);
        }
      } catch (error) {
        logger.error(`Critical error in loop for ${circle_code}-${serviceNumber}: ${error.message}`);
      } finally {
        if (page) await page.close();
        await new Promise(resolve => setTimeout(resolve, 1000 + Math.random() * 1500));
      }
    }
    logger.info(`✅ Completed circle ${circle_code}`);
    await updateCircleCodeStatus(id, 'COMPLETED');
  } catch (error) {
    logger.error(`Fatal error processing circle ${circle_code}: ${error.message}`);
    await updateCircleCodeStatus(id, 'FAILED');
  }
}

// Main automation function with a single browser instance
async function runAutomation() {
    logger.info('Automation engine started. Monitoring for tasks...');
    
    const browser = await setupBrowser(); // Launch browser ONCE

    try {
        // This loop runs forever
        while (true) {
            if (isProcessing) {
                await new Promise(resolve => setTimeout(resolve, 60000));
                continue;
            }

            const nextTask = await getNextPendingTask();

            if (nextTask) {
                isProcessing = true;
                logger.info(`New task found: Circle ${nextTask.circle_code}. Starting processing.`);
                await processCircleCode(nextTask, browser); // Pass the existing browser
                isProcessing = false;
                logger.info(`Task for circle ${nextTask.circle_code} finished. Resuming monitoring.`);
            } else {
                logger.info('No pending tasks found. Waiting for 1 minute before checking again.');
                await new Promise(resolve => setTimeout(resolve, 60000)); // 1 minute delay
            }
        }
    } catch (error) {
        logger.error(`A critical error occurred in the automation cycle: ${error.message}`);
    } finally {
        if (browser) await browser.close(); // Close the single browser on exit
        logger.info('Automation engine shutting down.');
    }
}

// API Routes
app.get('/', (req, res) => res.json({ message: 'Automation Backend', status: 'running', isProcessing }));
app.get('/status', (req, res) => res.json({ isProcessing }));


// Start server and initial automation run
app.listen(process.env.PORT || 3000, () => {
  logger.info(`Server running on port ${process.env.PORT || 3000}`);
  runAutomation(); // Kick off the continuous monitoring loop
});