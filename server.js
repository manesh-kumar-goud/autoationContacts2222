const express = require('express');
const puppeteer = require('puppeteer');
const { createClient } = require('@supabase/supabase-js');
const cron = require('node-cron');
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

// Security middleware
app.use(helmet());
app.use(compression());
app.use(cors());
app.use(express.json());

// Configure logging
const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.json()
  ),
  transports: [
    new winston.transports.File({ filename: 'error.log', level: 'error' }),
    new winston.transports.File({ filename: 'combined.log' }),
    new winston.transports.Console({
      format: winston.format.simple()
    })
  ]
});

// Initialize Supabase
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

// Global variables
let isProcessing = false;

// Optimized Puppeteer setup for maximum speed and stealth
async function setupBrowser() {
  try {
    const browser = await puppeteer.launch({
      headless: "new", // IMPORTANT: Change to 'false' for local debugging
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--no-first-run',
        '--no-zygote',
        '--disable-gpu',
        '--disable-infobars',
        '--window-position=0,0',
        '--ignore-certifcate-errors',
        '--ignore-certifcate-errors-spki-list',
        '--disable-extensions',
        '--disable-background-timer-throttling',
        '--disable-backgrounding-occluded-windows',
        '--disable-renderer-backgrounding',
        '--window-size=1920,1080'
      ]
    });
    
    logger.info('Browser setup completed');
    return browser;
  } catch (error) {
    logger.error('Browser setup failed:', error);
    throw error;
  }
}

// Ultra-fast service details fetcher
async function fetchServiceDetails(page, circleCode, serviceNumber) {
  try {
    await page.goto('https://tgsouthernpower.org/getUkscno', {
      waitUntil: 'domcontentloaded',
      timeout: 30000
    });

    await page.waitForSelector('#ukscno', { timeout: 10000 });
    await page.type('#ukscno', `${circleCode} ${serviceNumber}`, { delay: 0 });

    const submitButton = await page.$x("//button[contains(text(), 'Submit') or contains(text(), 'SUBMIT')]");
    if (submitButton.length > 0) {
      await Promise.all([
        page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 25000 }).catch(() => null),
        submitButton[0].click()
      ]);
    } else {
      await Promise.all([
        page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 25000 }).catch(() => null),
        page.keyboard.press('Enter')
      ]);
    }

    await page.waitForSelector('table', { timeout: 8000 }).catch(() => null);

    const serviceDetails = await page.evaluate(() => {
      const rows = document.querySelectorAll('table tr');
      const details = {
        serviceNo: 'Not Found', uniqueServiceNo: 'Not Found', customerName: 'Not Found',
        address: 'Not Found', ero: 'Not Found', mobile: 'Not Found', status: 'Failed'
      };
      for (let row of rows) {
        const cells = row.querySelectorAll('td');
        if (cells.length >= 6) {
          details.serviceNo = cells[0]?.textContent?.trim() || '';
          details.uniqueServiceNo = cells[1]?.textContent?.trim() || 'Not Found';
          details.customerName = cells[2]?.textContent?.trim() || 'Not Found';
          details.address = cells[3]?.textContent?.trim() || 'Not Found';
          details.ero = cells[4]?.textContent?.trim() || 'Not Found';
          details.mobile = cells[5]?.textContent?.trim() || 'Not Found';
          details.status = 'Success';
          break;
        }
      }
      return details;
    });

    if(serviceDetails.status !== 'Success'){
        serviceDetails.serviceNo = `${circleCode} ${serviceNumber}`;
    }

    return serviceDetails;

  } catch (error) {
    logger.error(`Error fetching service details for ${circleCode} ${serviceNumber}: ${error.message}`);
    return {
      serviceNo: `${circleCode} ${serviceNumber}`, uniqueServiceNo: 'Not Found', customerName: 'Not Found',
      address: 'Not Found', ero: 'Not Found', mobile: 'Not Found', status: 'Failed'
    };
  }
}

// More reliable bill amount fetcher
async function fetchBillAmount(page, ukscno) {
  try {
    if (ukscno === 'Not Found' || !ukscno) {
      return 'Not Found';
    }

    // STEP 1: Go to the form page
    await page.goto('https://tgsouthernpower.org/getBillAmount', {
      waitUntil: 'domcontentloaded',
      timeout: 30000
    });

    // STEP 2: Type in the UKSCNO and submit the form
    await page.waitForSelector('#ukscno', { timeout: 10000 });
    await page.type('#ukscno', ukscno, { delay: 20 }); // Small delay to mimic typing

    await Promise.all([
      page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 25000 }).catch(() => null),
      page.click('button[type="submit"]')
    ]);

    // STEP 3: Wait for the results table to appear on the new page
    await page.waitForSelector('table', { timeout: 8000 }).catch(() => {
        logger.warn(`Warning: Table not found for UKSCNO ${ukscno} after submission.`);
    });

    // STEP 4: Extract the bill amount from the table
    const billAmount = await page.evaluate(() => {
      const norm = (s) => (s || '').replace(/\s+/g, ' ').trim().toLowerCase();
      const rows = Array.from(document.querySelectorAll('table tr'));
      for (const row of rows) {
        const cells = row.querySelectorAll('td, th');
        if (cells.length > 1) {
            // Check if a label exists in any cell but the last one
            for (let i = 0; i < cells.length - 1; i++) {
                const labelText = norm(cells[i].textContent);
                if (labelText.includes('current month bill') || labelText.includes('total amount payable')) {
                    const amountText = cells[cells.length - 1].textContent.trim();
                    // Check if the amount cell contains a plausible value
                    if (amountText && amountText.match(/([0-9,]+\.?[0-9]*)/)) {
                        return amountText;
                    }
                }
            }
        }
      }
      return 'Not Found'; // Return 'Not Found' if no matching row is found
    });

    return billAmount || 'Not Found';

  } catch (error) {
    logger.error(`Error fetching bill for UKSCNO ${ukscno}: ${error.message}`);
    return 'Not Found'; // Return 'Not Found' on any error
  }
}

// Complete service processing
async function processService(page, circleCode, serviceNumber) {
  try {
    const serviceDetails = await fetchServiceDetails(page, circleCode, serviceNumber);
    let billAmount = 'Not Found';
    if (serviceDetails.status === 'Success') {
      billAmount = await fetchBillAmount(page, serviceDetails.uniqueServiceNo);
    }
    return { ...serviceDetails, billAmount, processedAt: new Date().toISOString() };
  } catch (error) {
    logger.error(`Error in processService for ${circleCode} ${serviceNumber}: ${error.message}`);
    return {
      serviceNo: `${circleCode} ${serviceNumber}`, uniqueServiceNo: 'Not Found', customerName: 'Not Found',
      address: 'Not Found', ero: 'Not Found', mobile: 'Not Found', billAmount: 'Not Found',
      status: 'Failed', processedAt: new Date().toISOString()
    };
  }
}

// Save data to Supabase
async function saveToSupabase(data) {
  try {
    const SAVE_ONLY_SUCCESS = process.env.SAVE_ONLY_SUCCESS !== 'false';
    const shouldSave = SAVE_ONLY_SUCCESS ? (data.status === 'Success') : true;

    if (shouldSave) {
      const { error } = await supabase.from('tgspdcl_automation_data').insert([
        {
          service_no: data.serviceNo, unique_service_no: data.uniqueServiceNo,
          customer_name: data.customerName, address: data.address,
          ero: data.ero, mobile: data.mobile, bill_amount: data.billAmount,
          fetch_status: data.status,
          search_info: {
            circle_code: data.serviceNo.split(' ')[0],
            service_number: data.serviceNo.split(' ')[1],
            processed_at: data.processedAt
          },
          status: 'COMPLETED'
        }
      ]);
      if (error) {
        logger.error(`Supabase insert error: ${error.message}`);
        return false;
      }
      return true;
    } else {
      logger.debug(`Skipping save for failed scrape: ${data.serviceNo}`);
      return true;
    }
  } catch (error) {
    logger.error(`Error saving to Supabase: ${error.message}`);
    return false;
  }
}

// Get pending circle codes from Supabase
async function getPendingCircleCodes() {
  try {
    const { data, error } = await supabase.from('circle_codes').select('*').eq('status', 'PENDING').order('id', { ascending: true });
    if (error) throw error;
    return data || [];
  } catch (error) {
    logger.error(`Error fetching pending circle codes: ${error.message}`);
    return [];
  }
}

// Update circle code status
async function updateCircleCodeStatus(id, status) {
  try {
    const { error } = await supabase.from('circle_codes').update({ status }).eq('id', id);
    if (error) throw error;
    return true;
  } catch (error) {
    logger.error(`Error updating circle code status for ${id}: ${error.message}`);
    return false;
  }
}

// Main processing function
async function processCircleCode(circleCode, digitsInServiceCode) {
  logger.info(`Starting processing for circle code: ${circleCode} with ${digitsInServiceCode} digits`);
  
  const browser = await setupBrowser();
  
  try {
    const maxNumber = Math.pow(10, digitsInServiceCode) - 1;
    let startIndex = Number.parseInt(process.env.START_INDEX ?? '0', 10);
    let endIndex = Number.parseInt(process.env.END_INDEX ?? String(maxNumber), 10);
    startIndex = Math.max(0, startIndex);
    endIndex = Math.min(endIndex, maxNumber);

    logger.info(`Processing range: ${String(startIndex).padStart(digitsInServiceCode, '0')} to ${String(endIndex).padStart(digitsInServiceCode, '0')}`);
    
    let processedCount = 0, successCount = 0, savedCount = 0;
    const totalToProcess = Math.abs(endIndex - startIndex) + 1;
    
    for (let i = startIndex; i <= endIndex; i++) {
      const serviceNumber = i.toString().padStart(digitsInServiceCode, '0');
      let page = null;

      try {
        page = await browser.newPage();
        
        await page.setDefaultNavigationTimeout(45000); // Increased timeout
        await page.setViewport({ width: 1920, height: 1080 });

        const randomUA = userAgents[Math.floor(Math.random() * userAgents.length)];
        await page.setUserAgent(randomUA);
        
        await page.setRequestInterception(true);
        page.on('request', (req) => {
          if (['image', 'stylesheet', 'font', 'media'].includes(req.resourceType())) {
            req.abort();
          } else {
            req.continue();
          }
        });
        
        const result = await processService(page, circleCode, serviceNumber);
        const saved = await saveToSupabase(result);
        
        processedCount++;
        if (result.status === 'Success') successCount++;
        if (saved && result.status === 'Success') savedCount++;

        if (processedCount % 10 === 0) { // More frequent progress logging
          logger.info(`Progress: ${processedCount}/${totalToProcess} (${successCount} found, ${savedCount} saved) for circle ${circleCode}`);
        }
        
      } catch (error) {
        logger.error(`Critical error in loop for ${circleCode} ${serviceNumber}: ${error.message}`);
        processedCount++;
      } finally {
        if (page) await page.close();
        
        // LONGER, MORE RANDOMIZED DELAY
        const delay = 1000 + Math.floor(Math.random() * 1500); // Wait 1 to 2.5 seconds
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }

    logger.info(`✅ Completed circle ${circleCode}: ${processedCount} processed, ${successCount} found, ${savedCount} saved`);
    return { processedCount, successCount, savedCount };

  } catch (error) {
    logger.error(`Fatal error in processCircleCode for ${circleCode}: ${error.message}`);
    throw error;
  } finally {
    if (browser) await browser.close();
  }
}

// Main automation function
async function runAutomation() {
  if (isProcessing) {
    logger.info('Automation already running, skipping...');
    return;
  }
  isProcessing = true;
  logger.info('Starting automation process...');

  try {
    const pendingCircleCodes = await getPendingCircleCodes();
    if (pendingCircleCodes.length === 0) {
      logger.info('No pending tasks found. Waiting...');
      return;
    }

    logger.info(`Found ${pendingCircleCodes.length} pending circle codes.`);
    for (const circle of pendingCircleCodes) {
      try {
        logger.info(`🔄 Starting processing for circle ${circle.circle_code}`);
        await updateCircleCodeStatus(circle.id, 'PROCESSING');
        await processCircleCode(circle.circle_code, circle.digits_in_service_code);
        await updateCircleCodeStatus(circle.id, 'COMPLETED');
        logger.info(`✅ Circle ${circle.circle_code} completed.`);
      } catch (error) {
        logger.error(`❌ Error processing circle ${circle.circle_code}: ${error.message}`);
        await updateCircleCodeStatus(circle.id, 'FAILED');
      }
    }
  } catch (error) {
    logger.error(`Error in main automation function: ${error.message}`);
  } finally {
    isProcessing = false;
    logger.info('Automation cycle finished.');
  }
}

// API Routes
app.get('/', (req, res) => res.json({ message: 'Automation Backend', status: 'running', isProcessing }));
app.post('/start', (req, res) => {
  if (isProcessing) return res.status(409).json({ success: false, message: 'Automation already in progress.' });
  runAutomation();
  res.json({ success: true, message: 'Automation triggered.' });
});
app.get('/status', (req, res) => res.json({ isProcessing }));

// Cron jobs
cron.schedule('*/5 * * * *', () => {
  logger.info('Cron job: Checking for new pending tasks...');
  runAutomation();
});

// Start server
app.listen(process.env.PORT || 3000, () => {
  logger.info(`Server running on port ${process.env.PORT || 3000}`);
  logger.info('Automation backend ready. Starting initial check...');
  runAutomation();
});