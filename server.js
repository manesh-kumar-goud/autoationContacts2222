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

// Optimized Puppeteer setup
async function setupBrowser() {
  try {
    const browser = await puppeteer.launch({
      headless: "new",
      args: [
        '--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas', '--no-first-run', '--no-zygote',
        '--disable-gpu', '--disable-infobars', '--window-position=0,0',
        '--ignore-certifcate-errors', '--ignore-certifcate-errors-spki-list',
        '--disable-extensions', '--window-size=1920,1080'
      ]
    });
    logger.info('Browser setup completed');
    return browser;
  } catch (error) {
    logger.error('Browser setup failed:', error);
    throw error;
  }
}

// Service details fetcher
async function fetchServiceDetails(page, circleCode, serviceNumber) {
  try {
    await page.goto('https://tgsouthernpower.org/getUkscno', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForSelector('#ukscno', { timeout: 10000 });
    await page.type('#ukscno', `${circleCode} ${serviceNumber}`, { delay: 0 });

    await Promise.all([
        page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 25000 }).catch(() => null),
        page.click('button[type="submit"]')
    ]);

    await page.waitForSelector('table', { timeout: 8000 }).catch(() => null);

    const serviceDetails = await page.evaluate(() => {
      const rows = document.querySelectorAll('table tr');
      const details = {
        serviceNo: 'Not Found', uniqueServiceNo: 'Not Found', customerName: 'Not Found',
        address: 'Not Found', ero: 'Not Found', mobile: 'Not Found', status: 'Failed'
      };
      for (const row of rows) {
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

    if (serviceDetails.status !== 'Success') {
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

// Bill amount fetcher
async function fetchBillAmount(page, ukscno) {
  try {
    if (ukscno === 'Not Found' || !ukscno) return 'Not Found';

    await page.goto('https://tgsouthernpower.org/getBillAmount', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForSelector('#ukscno', { timeout: 10000 });
    await page.type('#ukscno', ukscno, { delay: 20 });
    await Promise.all([
      page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 25000 }).catch(() => null),
      page.click('button[type="submit"]')
    ]);

    await page.waitForSelector('table', { timeout: 8000 }).catch(() => logger.warn(`Table not found for UKSCNO ${ukscno}`));

    const billAmount = await page.evaluate(() => {
      const norm = (s) => (s || '').replace(/\s+/g, ' ').trim().toLowerCase();
      const rows = Array.from(document.querySelectorAll('table tr'));
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
    return billAmount || 'Not Found';
  } catch (error) {
    logger.error(`Error fetching bill for UKSCNO ${ukscno}: ${error.message}`);
    return 'Not Found';
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
    if (process.env.SAVE_ONLY_SUCCESS === 'true' && data.status !== 'Success') {
      logger.debug(`Skipping save for failed scrape: ${data.serviceNo}`);
      return true;
    }

    const { error } = await supabase.from('tgspdcl_automation_data').insert([{
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
    }]);
    if (error) {
        logger.error(`Supabase insert error: ${error.message}`);
        return false;
    }
    return true;
  } catch (error) {
    logger.error(`Error saving to Supabase: ${error.message}`);
    return false;
  }
}

// Get the next pending circle code
async function getNextPendingTask() {
  try {
    const { data, error } = await supabase
      .from('circle_codes')
      .select('*')
      .eq('status', 'PENDING')
      .order('id', { ascending: true })
      .limit(1);

    if (error) throw error;
    return data && data.length > 0 ? data[0] : null;
  } catch (error) {
    logger.error(`Error fetching next pending task: ${error.message}`);
    return null;
  }
}

// Update circle code status
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

// Main processing function for a single circle code
async function processCircleCode(circle, browser) {
  const { circle_code, digits_in_service_code, id } = circle;
  logger.info(`Starting processing for circle code: ${circle_code} with ${digits_in_service_code} digits`);
  
  try {
    await updateCircleCodeStatus(id, 'PROCESSING');
    
    const maxNumber = Math.pow(10, digits_in_service_code) - 1;
    let startIndex = Number.parseInt(process.env.START_INDEX ?? '0', 10);
    let endIndex = Number.parseInt(process.env.END_INDEX ?? String(maxNumber), 10);
    startIndex = Math.max(0, startIndex);
    endIndex = Math.min(endIndex, maxNumber);

    logger.info(`Processing range: ${String(startIndex).padStart(digits_in_service_code, '0')} to ${String(endIndex).padStart(digits_in_service_code, '0')}`);
    
    let processedCount = 0, successCount = 0, savedCount = 0;
    const totalToProcess = Math.abs(endIndex - startIndex) + 1;
    
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
        const saved = await saveToSupabase(result);
        
        processedCount++;
        if (result.status === 'Success') successCount++;
        if (saved && result.status === 'Success') savedCount++;

        if (processedCount % 10 === 0) {
          logger.info(`Progress: ${processedCount}/${totalToProcess} (${successCount} found) for circle ${circle_code}`);
        }
        
      } catch (error) {
        logger.error(`Critical error in loop for ${circle_code} ${serviceNumber}: ${error.message}`);
        processedCount++;
      } finally {
        if (page) await page.close();
        const delay = 1000 + Math.floor(Math.random() * 1500);
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }

    logger.info(`✅ Completed circle ${circle_code}: ${processedCount} processed, ${successCount} found`);
    await updateCircleCodeStatus(id, 'COMPLETED');
  } catch (error) {
    logger.error(`Fatal error processing circle ${circle_code}: ${error.message}`);
    await updateCircleCodeStatus(id, 'FAILED');
    throw error;
  }
}

// Main automation function with a continuous loop
async function runAutomation() {
  if (isProcessing) {
    logger.info('Automation cycle is already running. Skipping trigger.');
    return;
  }
  isProcessing = true;
  logger.info('Starting automation cycle...');

  const browser = await setupBrowser();
  
  try {
    while (true) {
      const nextTask = await getNextPendingTask();
      
      if (nextTask) {
        logger.info(`Found pending task: Circle ${nextTask.circle_code}`);
        await processCircleCode(nextTask, browser);
      } else {
        logger.info('No more pending tasks found. Automation will now idle.');
        break; // Exit the while loop
      }
    }
  } catch (error) {
    logger.error(`A critical error occurred in the automation cycle: ${error.message}`);
  } finally {
    if (browser) await browser.close();
    isProcessing = false;
    logger.info('Automation cycle finished.');
  }
}

// API Routes
app.get('/', (req, res) => res.json({ message: 'Automation Backend', status: 'running', isProcessing }));
app.post('/start', (req, res) => {
  if (isProcessing) {
    return res.status(409).json({ success: false, message: 'Automation is already in progress.' });
  }
  // Run in background and immediately respond
  runAutomation();
  res.json({ success: true, message: 'Automation cycle triggered.' });
});
app.get('/status', (req, res) => res.json({ isProcessing }));


// Start server
app.listen(process.env.PORT || 3000, () => {
  logger.info(`Server running on port ${process.env.PORT || 3000}`);
  logger.info('Automation backend ready. Starting initial check...');
  runAutomation();
});