const express = require('express');
const puppeteer = require('puppeteer');
const { createClient } = require('@supabase/supabase-js');
const cron = require('node-cron');
const winston = require('winston');
const cors = require('cors');
const helmet = require('helmet');
const compression = require('compression');
require('dotenv').config();

// Express app
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
  transports: [new winston.transports.Console({ format: winston.format.simple() })]
});

// Supabase
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

// Global
let isProcessing = false;

// Puppeteer setup optimized for Render free tier
async function setupBrowser() {
  return puppeteer.launch({
    headless: "new",
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--disable-extensions',
      '--single-process',
      '--no-zygote'
    ]
  });
}

// Existing fetchServiceDetails function (unchanged except logs)
async function fetchServiceDetails(page, circleCode, serviceNumber) {
  try {
    await page.goto('https://tgsouthernpower.org/getUkscno', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForSelector('#ukscno', { timeout: 10000 });
    await page.type('#ukscno', `${circleCode} ${serviceNumber}`, { delay: 0 });

    const submitButton = await page.$x("//button[contains(text(), 'Submit') or contains(text(), 'SUBMIT')]");
    if (submitButton.length > 0) {
      await Promise.all([
        submitButton[0].click(),
        page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => null)
      ]);
    } else {
      await page.keyboard.press('Enter');
    }

    await page.waitForTimeout(1000);

    const details = await page.evaluate(() => {
      const rows = document.querySelectorAll('table tr');
      const result = {
        serviceNo: '',
        uniqueServiceNo: 'Not Found',
        customerName: 'Not Found',
        address: 'Not Found',
        ero: 'Not Found',
        mobile: 'Not Found',
        status: 'Failed'
      };
      for (let row of rows) {
        const cells = row.querySelectorAll('td');
        if (cells.length >= 6) {
          result.serviceNo = cells[0].innerText.trim();
          result.uniqueServiceNo = cells[1].innerText.trim();
          result.customerName = cells[2].innerText.trim();
          result.address = cells[3].innerText.trim();
          result.ero = cells[4].innerText.trim();
          result.mobile = cells[5].innerText.trim();
          result.status = 'Success';
          break;
        }
      }
      return result;
    });

    return details;
  } catch (error) {
    logger.error(`Error fetching service details for ${circleCode} ${serviceNumber}:`, error);
    return { serviceNo: `${circleCode} ${serviceNumber}`, uniqueServiceNo: 'Not Found', status: 'Failed' };
  }
}

// Save to Supabase
async function saveToSupabase(data) {
  const SAVE_ONLY_SUCCESS = process.env.SAVE_ONLY_SUCCESS !== 'false';
  if (SAVE_ONLY_SUCCESS && data.status !== 'Success') return;
  const { error } = await supabase.from('tgspdcl_automation_data').insert([{
    service_no: data.serviceNo,
    unique_service_no: data.uniqueServiceNo,
    customer_name: data.customerName,
    address: data.address,
    ero: data.ero,
    mobile: data.mobile,
    bill_amount: data.billAmount || 'Not Found',
    fetch_status: data.status,
    processed_at: new Date().toISOString()
  }]);
  if (error) logger.error('Supabase insert error:', error);
}

// Process a circle code with browser restart every batch
async function processCircleCode(circleCode, digitsInServiceCode) {
  const BATCH_SIZE = 10;
  let processedCount = 0;

  const maxNumber = Math.pow(10, digitsInServiceCode) - 1;
  const startIndex = parseInt(process.env.START_INDEX || 0);
  const endIndex = parseInt(process.env.END_INDEX || maxNumber);

  let browser = null;
  let page = null;

  for (let i = startIndex; i <= endIndex; i++) {
    if (processedCount % BATCH_SIZE === 0) {
      if (browser) await browser.close();
      browser = await setupBrowser();
      page = await browser.newPage();
      await page.setDefaultNavigationTimeout(30000);
    }

    const serviceNumber = i.toString().padStart(digitsInServiceCode, '0');
    const details = await fetchServiceDetails(page, circleCode, serviceNumber);
    await saveToSupabase(details);

    processedCount++;
    await page.waitForTimeout(250); // small delay to avoid rate limits
  }

  if (browser) await browser.close();
}

// Automation runner
async function runAutomation() {
  if (isProcessing) return;
  isProcessing = true;
  logger.info('Automation started');

  const { data: pendingCodes } = await supabase.from('circle_codes').select('*').eq('status', 'PENDING');
  if (!pendingCodes?.length) {
    logger.info('No pending codes');
    isProcessing = false;
    return;
  }

  for (const code of pendingCodes) {
    await supabase.from('circle_codes').update({ status: 'PROCESSING' }).eq('id', code.id);
    await processCircleCode(code.circle_code, code.digits_in_service_code);
    await supabase.from('circle_codes').update({ status: 'COMPLETED' }).eq('id', code.id);
  }

  isProcessing = false;
  logger.info('Automation finished');
}

// Routes
app.get('/', (req, res) => res.json({ status: 'running', isProcessing }));

app.post('/start-automation', (req, res) => {
  runAutomation();
  res.json({ started: true });
});

// CRON to check every 5 minutes
cron.schedule('*/5 * * * *', () => {
  if (!isProcessing) runAutomation();
});

app.listen(PORT, () => logger.info(`Server running on ${PORT}`));
