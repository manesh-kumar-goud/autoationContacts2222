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
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/15.1 Safari/605.1.15',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
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

// Optimized Puppeteer setup for maximum speed
async function setupBrowser() {
  try {
    const browser = await puppeteer.launch({
      headless: "new",
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--no-first-run',
        '--no-zygote',
        '--disable-gpu',
        '--disable-extensions',
        '--disable-plugins',
        '--disable-background-timer-throttling',
        '--disable-backgrounding-occluded-windows',
        '--disable-renderer-backgrounding',
        '--disable-features=TranslateUI',
        '--disable-background-networking',
        '--disable-sync',
        '--disable-default-apps',
        '--fast-start',
        '--disable-web-security',
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

    // Wait for input field and enter data
    await page.waitForSelector('#ukscno', { timeout: 10000 });
    await page.type('#ukscno', `${circleCode} ${serviceNumber}`, { delay: 0 });

    // Find and click submit button
    const submitButton = await page.$x("//button[contains(text(), 'Submit') or contains(text(), 'SUBMIT')]");
    const navOrResults = Promise.race([
      page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 25000 }).catch(() => null),
      page.waitForFunction(() => {
        const hasRows = document.querySelectorAll('table tr').length > 0;
        const hasTable = document.querySelector('table') !== null;
        const hasTds = document.querySelectorAll('td').length > 0;
        return hasRows || hasTable || hasTds;
      }, { timeout: 25000 }).catch(() => null)
    ]);
    if (submitButton.length > 0) {
      await Promise.all([
        submitButton[0].click(),
        navOrResults
      ]);
    } else {
      // Fallback: press Enter to submit the form
      await Promise.all([
        page.keyboard.press('Enter'),
        navOrResults
      ]);
    }

    // Wait briefly for any result signal; don't block too long per attempt
    await page.waitForFunction(() => {
      const hasRows = document.querySelectorAll('table tr').length > 0;
      const hasTable = document.querySelector('table') !== null;
      const hasTds = document.querySelectorAll('td').length > 0;
      return hasRows || hasTable || hasTds;
    }, { timeout: 8000 }).catch(() => null);

    // Extract service details
    let serviceDetails;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        serviceDetails = await page.evaluate(() => {
          const rows = document.querySelectorAll('table tr');
          const details = {
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
        break;
      } catch (err) {
        // Retry once if the page navigated mid-evaluate
        await new Promise(resolve => setTimeout(resolve, 500));
      }
    }
    if (!serviceDetails) {
      serviceDetails = {
        serviceNo: `${circleCode} ${serviceNumber}`,
        uniqueServiceNo: 'Not Found',
        customerName: 'Not Found',
        address: 'Not Found',
        ero: 'Not Found',
        mobile: 'Not Found',
        status: 'Failed'
      };
    }

    return serviceDetails;
  } catch (error) {
    logger.error(`Error fetching service details for ${circleCode} ${serviceNumber}:`, error);
    return {
      serviceNo: `${circleCode} ${serviceNumber}`,
      uniqueServiceNo: 'Not Found',
      customerName: 'Not Found',
      address: 'Not Found',
      ero: 'Not Found',
      mobile: 'Not Found',
      status: 'Failed'
    };
  }
}

// Ultra-fast bill amount fetcher
async function fetchBillAmount(page, ukscno) {
  try {
    if (ukscno === 'Not Found') {
      return 'Not Found';
    }

    await page.goto('https://tgsouthernpower.org/getBillAmount', {
      waitUntil: 'domcontentloaded',
      timeout: 30000
    });

    // Try multiple input selectors; fall back if not found
    const candidateSelectors = [
      '#ukscno',
      "input[name='ukscno']",
      "input[id*='ukscno' i]",
      "input[id*='uksc' i]",
      "input[type='text']"
    ];
    let inputSelector = null;
    for (const sel of candidateSelectors) {
      try {
        await page.waitForSelector(sel, { timeout: 3000 });
        inputSelector = sel;
        break;
      } catch {}
    }
    if (inputSelector) {
      await page.click(inputSelector, { clickCount: 3 }).catch(() => {});
      await page.type(inputSelector, ukscno, { delay: 0 });
    } else {
      // If input not found, try direct navigation to billing page with query params
      const directUrls = [
        `https://tgsouthernpower.org/billinginfo?ukscno=${encodeURIComponent(ukscno)}`,
        `https://tgsouthernpower.org/billinginfo?uniqueServiceNo=${encodeURIComponent(ukscno)}`
      ];
      for (const url of directUrls) {
        try {
          await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
          break;
        } catch {}
      }
    }

    // Find and click submit button
    const submitButton = await page.$x("//button[contains(text(), 'Submit') or contains(text(), 'SUBMIT')]");
    const navOrResults = Promise.race([
      page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 25000 }).catch(() => null),
      page.waitForFunction(() => {
        const hasRows = document.querySelectorAll('table tr').length > 0;
        const hasTable = document.querySelector('table') !== null;
        const hasTds = document.querySelectorAll('td').length > 0;
        return hasRows || hasTable || hasTds || /billinginfo/i.test(location.href);
      }, { timeout: 25000 }).catch(() => null)
    ]);
    if (inputSelector && submitButton.length > 0) {
      await Promise.all([
        submitButton[0].click(),
        navOrResults
      ]);
    } else if (inputSelector) {
      await Promise.all([
        page.keyboard.press('Enter'),
        navOrResults
      ]);
    }

    // Ensure we are on billinginfo page; if not, navigate directly as a fallback
    try {
      await page.waitForFunction(() => /billinginfo/i.test(page.url()), { timeout: 5000 });
    } catch {}
    if (!/billinginfo/i.test(page.url())) {
      try {
        await page.goto(`https://tgsouthernpower.org/billinginfo?ukscno=${encodeURIComponent(ukscno)}`, {
          waitUntil: 'domcontentloaded',
          timeout: 30000
        });
      } catch {}
    }

    // Wait for any results signal briefly; also support known billinginfo page
    await Promise.race([
      page.waitForFunction(() => {
        const hasRows = document.querySelectorAll('table tr').length > 0;
        const hasTable = document.querySelector('table') !== null;
        const hasTds = document.querySelectorAll('td').length > 0;
        return hasRows || hasTable || hasTds;
      }, { timeout: 8000 }).catch(() => null),
      page.waitForFunction(() => /billinginfo/i.test(location.pathname) || /billinginfo/i.test(location.href), { timeout: 8000 }).catch(() => null)
    ]);
    // Best-effort wait for a visible table
    await page.waitForSelector('table', { timeout: 4000 }).catch(() => null);

    // Extract bill amount
    let billAmount = 'Not Found';
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        billAmount = await page.evaluate(() => {
          const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();
          const parseAmountText = (t) => {
            const m = norm(t).match(/(₹|rs\.?\s*)?\s*([0-9][0-9,]*\.?[0-9]*)/i);
            return m ? m[0].trim() : null;
          };
          const extractFromCells = (cells) => {
            // Prefer the last td which usually holds the value under 'Amount'
            for (let i = cells.length - 1; i >= 0; i--) {
              const amt = parseAmountText(cells[i].textContent);
              if (amt) return amt;
            }
            return null;
          };
          const findByLabel = (regex) => {
            const rows = Array.from(document.querySelectorAll('table tr'));
            for (let i = 0; i < rows.length; i++) {
              const row = rows[i];
              const rowText = norm(row.textContent);
              if (!regex.test(rowText)) continue;
              // Try same row
              let amt = extractFromCells(Array.from(row.querySelectorAll('td')));
              if (amt) return amt;
              // Try next 2 rows (often hold Date/Amount)
              for (let j = 1; j <= 2 && i + j < rows.length; j++) {
                amt = extractFromCells(Array.from(rows[i + j].querySelectorAll('td')));
                if (amt) return amt;
              }
              break;
            }
            return null;
          };

          // 1) Strictly prefer Current Month Bill
          let amt = findByLabel(/current\s*month\s*bill/i);
          if (amt) return amt;
          // 2) Fallback to Total Amount Payable
          amt = findByLabel(/total\s*amount\s*payable/i);
          if (amt) return amt;
          // 3) Last resort: any visible ₹ on the page
          const any = [...document.body.innerText.matchAll(/₹\s*[0-9][0-9,]*\.?[0-9]*/g)].map((m) => m[0].trim());
          return any.length > 0 ? any[0] : 'Not Found';
        });
        break;
      } catch (err) {
        await new Promise(resolve => setTimeout(resolve, 500));
      }
    }

    return billAmount;
  } catch (error) {
    logger.error(`Error fetching bill amount for UKSCNO ${ukscno}:`, error);
    return 'Not Found';
  }
}

// Complete service processing
async function processService(page, circleCode, serviceNumber) {
  try {
    // Clear any previous input value if the site keeps the field
    try {
      await page.evaluate(() => {
        const input = document.querySelector('#ukscno');
        if (input) input.value = '';
      });
    } catch {}
    // Step 1: Get service details
    const serviceDetails = await fetchServiceDetails(page, circleCode, serviceNumber);
    
    // Step 2: Get bill amount if service found
    let billAmount = 'Not Found';
    if (serviceDetails.status === 'Success') {
      billAmount = await fetchBillAmount(page, serviceDetails.uniqueServiceNo);
    }

    return {
      ...serviceDetails,
      billAmount,
      processedAt: new Date().toISOString()
    };
  } catch (error) {
    logger.error(`Error processing service ${circleCode} ${serviceNumber}:`, error);
    return {
      serviceNo: `${circleCode} ${serviceNumber}`,
      uniqueServiceNo: 'Not Found',
      customerName: 'Not Found',
      address: 'Not Found',
      ero: 'Not Found',
      mobile: 'Not Found',
      billAmount: 'Not Found',
      status: 'Failed',
      processedAt: new Date().toISOString()
    };
  }
}

// Save data to Supabase - configurable to save only successes or all results
async function saveToSupabase(data) {
  try {
    const SAVE_ONLY_SUCCESS = process.env.SAVE_ONLY_SUCCESS !== 'false';
    const shouldSave = SAVE_ONLY_SUCCESS
      ? (data.status === 'Success' && data.uniqueServiceNo !== 'Not Found')
      : true;

    if (shouldSave) {
      const { error } = await supabase
        .from('tgspdcl_automation_data')
        .insert([{
          service_no: data.serviceNo,
          unique_service_no: data.uniqueServiceNo,
          customer_name: data.customerName,
          address: data.address,
          ero: data.ero,
          mobile: data.mobile,
          bill_amount: data.billAmount,
          fetch_status: data.status,
          search_info: {
            circle_code: data.serviceNo.split(' ')[0],
            service_number: data.serviceNo.split(' ')[1],
            processed_at: data.processedAt
          },
          status: data.status === 'Success' ? 'COMPLETED' : 'FAILED'
        }]);

      if (error) {
        logger.error('Supabase insert error:', error);
        return false;
      }
      logger.debug(`✅ Saved result for ${data.serviceNo} (Status: ${data.status})`);
      return true;
    } else {
      // Skip saving failed/invalid service numbers
      logger.debug(`⏭️ Skipping save: ${data.serviceNo} (Status: ${data.status})`);
      return true; // Return true to continue processing
    }
  } catch (error) {
    logger.error('Error saving to Supabase:', error);
    return false;
  }
}

// Get pending circle codes from Supabase
async function getPendingCircleCodes() {
  try {
    const { data, error } = await supabase
      .from('circle_codes')
      .select('*')
      .eq('status', 'PENDING')
      .order('id', { ascending: true });

    if (error) {
      logger.error('Error fetching pending circle codes:', error);
      return [];
    }

    return data || [];
  } catch (error) {
    logger.error('Error in getPendingCircleCodes:', error);
    return [];
  }
}

// Update circle code status
async function updateCircleCodeStatus(id, status) {
  try {
    const { error } = await supabase
      .from('circle_codes')
      .update({ status })
      .eq('id', id);

    if (error) {
      logger.error('Error updating circle code status:', error);
      return false;
    }
    return true;
  } catch (error) {
    logger.error('Error in updateCircleCodeStatus:', error);
    return false;
  }
}

// Main processing function
async function processCircleCode(circleCode, digitsInServiceCode) {
  logger.info(`Starting processing for circle code: ${circleCode} with ${digitsInServiceCode} digits`);
  
  const browser = await setupBrowser();
  
  try {
    const maxNumber = Math.pow(10, digitsInServiceCode) - 1;
    const parsedStart = Number.parseInt(process.env.START_INDEX ?? '0', 10);
    const parsedEnd = Number.parseInt(process.env.END_INDEX ?? String(maxNumber), 10);
    let startIndex = Number.isFinite(parsedStart) ? parsedStart : 0;
    let endIndex = Number.isFinite(parsedEnd) ? parsedEnd : maxNumber;
    startIndex = Math.min(Math.max(0, startIndex), maxNumber);
    endIndex = Math.min(Math.max(0, endIndex), maxNumber);

    const startLabel = startIndex.toString().padStart(digitsInServiceCode, '0');
    const endLabel = endIndex.toString().padStart(digitsInServiceCode, '0');
    logger.info(`Processing range: ${startLabel} to ${endLabel}`);
    
    let processedCount = 0;
    let successCount = 0;
    let savedCount = 0;
    
    const ascending = startIndex <= endIndex;
    const totalToProcess = Math.abs(endIndex - startIndex) + 1;
    
    // This single loop handles both ascending and descending order correctly.
    for (let i = startIndex; ascending ? i <= endIndex : i >= endIndex; i = ascending ? i + 1 : i - 1) {
      const serviceNumber = i.toString().padStart(digitsInServiceCode, '0');
      let page = null; // Define page here to access it in the finally block

      try {
        // Create a fresh page for each iteration for maximum stability
        page = await browser.newPage();
        
        // Configure the new page
        await page.setDefaultNavigationTimeout(30000);
        await page.setViewport({ width: 1280, height: 800 });

        // Rotate user agent for each request
        const randomUA = userAgents[Math.floor(Math.random() * userAgents.length)];
        await page.setUserAgent(randomUA);
        
        // Set up request interception to block images/css for speed
        await page.setRequestInterception(true);
        page.on('request', (req) => {
          if (['image', 'stylesheet', 'font', 'media'].includes(req.resourceType())) {
            req.abort();
          } else {
            req.continue();
          }
        });
        
        // Process the service number
        const result = await processService(page, circleCode, serviceNumber);
        const saved = await saveToSupabase(result);
        
        processedCount++;
        if (result.status === 'Success') successCount++;
        if (saved && result.status === 'Success') savedCount++;

        if (processedCount % 50 === 0) {
          logger.info(`Progress: ${processedCount}/${totalToProcess} (${successCount} found, ${savedCount} saved) for circle ${circleCode}`);
        }
        
      } catch (error) {
        logger.error(`Unhandled error in loop for ${circleCode} ${serviceNumber}:`, error);
        processedCount++; // Still count it as a processed attempt
      } finally {
        // Ensure the page is always closed to prevent memory leaks
        if (page) await page.close();
        
        // Add a small, randomized delay to appear more human-like
        await new Promise(resolve => setTimeout(resolve, 150 + Math.floor(Math.random() * 250)));
      }
    }

    logger.info(`✅ Completed circle ${circleCode}: ${processedCount} processed, ${successCount} found, ${savedCount} saved to database`);
    return { processedCount, successCount, savedCount };

  } catch (error) {
    logger.error(`Fatal error in processCircleCode for ${circleCode}:`, error);
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
      logger.info('No pending circle codes found - waiting for new tasks...');
      logger.info('💡 Add new circle codes to the database to start processing');
      return;
    }

    logger.info(`Found ${pendingCircleCodes.length} pending circle codes`);

    for (const circleCode of pendingCircleCodes) {
      try {
        logger.info(`🔄 Starting processing for circle ${circleCode.circle_code} (${circleCode.digits_in_service_code} digits)`);
        
        // Update status to PROCESSING
        await updateCircleCodeStatus(circleCode.id, 'PROCESSING');
        
        // Process the circle code
        const result = await processCircleCode(circleCode.circle_code, circleCode.digits_in_service_code);
        
        // Update status to COMPLETED
        await updateCircleCodeStatus(circleCode.id, 'COMPLETED');
        
        logger.info(`✅ Circle ${circleCode.circle_code} completed: ${result.processedCount} processed, ${result.successCount} found, ${result.savedCount} saved to database`);
        
      } catch (error) {
        logger.error(`❌ Error processing circle ${circleCode.circle_code}:`, error);
        await updateCircleCodeStatus(circleCode.id, 'FAILED');
      }
    }

    // Check if there are more pending tasks after completion
    const remainingPending = await getPendingCircleCodes();
    if (remainingPending.length === 0) {
      logger.info('🎉 All pending tasks completed! Monitoring for new tasks...');
      logger.info('📝 Add new circle codes to continue processing');
    } else {
      logger.info(`🔄 ${remainingPending.length} more pending tasks found, continuing...`);
    }

  } catch (error) {
    logger.error('Error in main automation:', error);
  } finally {
    isProcessing = false;
    logger.info('Automation process completed - monitoring continues...');
  }
}

// API Routes
app.get('/', (req, res) => {
  res.json({
    message: 'TGSPDCL Ultra-Fast Automation Backend',
    status: 'running',
    isProcessing
  });
});

app.post('/start-automation', async (req, res) => {
  try {
    if (isProcessing) {
      return res.json({ success: false, message: 'Automation already running' });
    }

    // Start automation in background
    runAutomation();
    
    res.json({ success: true, message: 'Automation started' });
  } catch (error) {
    logger.error('Error starting automation:', error);
    res.status(500).json({ success: false, message: 'Error starting automation' });
  }
});

app.get('/status', (req, res) => {
  res.json({
    isProcessing,
    timestamp: new Date().toISOString()
  });
});

app.get('/check-pending', async (req, res) => {
  try {
    const pendingCircleCodes = await getPendingCircleCodes();
    res.json({
      success: true,
      pendingCount: pendingCircleCodes.length,
      pendingCodes: pendingCircleCodes.map(code => ({
        id: code.id,
        circle_code: code.circle_code,
        digits_in_service_code: code.digits_in_service_code,
        status: code.status,
        created_at: code.created_at
      })),
      isProcessing,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    logger.error('Error checking pending codes:', error);
    res.status(500).json({ success: false, message: 'Error checking pending codes' });
  }
});

app.get('/stats', async (req, res) => {
  try {
    // Get total records in database
    const { count: totalRecords } = await supabase
      .from('tgspdcl_automation_data')
      .select('*', { count: 'exact', head: true });

    // Get successful records
    const { count: successfulRecords } = await supabase
      .from('tgspdcl_automation_data')
      .select('*', { count: 'exact', head: true })
      .eq('fetch_status', 'Success');

    // Get circle codes statistics
    const { data: circleStats } = await supabase
      .from('circle_codes')
      .select('status');

    const circleCounts = {
      pending: circleStats?.filter(c => c.status === 'PENDING').length || 0,
      processing: circleStats?.filter(c => c.status === 'PROCESSING').length || 0,
      completed: circleStats?.filter(c => c.status === 'COMPLETED').length || 0,
      failed: circleStats?.filter(c => c.status === 'FAILED').length || 0
    };

    res.json({
      success: true,
      database: {
        totalRecords: totalRecords || 0,
        successfulRecords: successfulRecords || 0,
        failedRecords: (totalRecords || 0) - (successfulRecords || 0)
      },
      circleCodes: circleCounts,
      isProcessing,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    logger.error('Error getting stats:', error);
    res.status(500).json({ success: false, message: 'Error getting statistics' });
  }
});

// Schedule automation to run every hour
cron.schedule('0 * * * *', () => {
  logger.info('Scheduled automation triggered');
  runAutomation();
});

// Continuous monitoring - check for new pending tasks every 5 minutes
cron.schedule('*/5 * * * *', () => {
  if (!isProcessing) {
    logger.info('Checking for new pending circle codes...');
    runAutomation();
  }
});

// Start server
app.listen(PORT, () => {
  logger.info(`Server running on port ${PORT}`);
  logger.info('Automation backend ready');
});