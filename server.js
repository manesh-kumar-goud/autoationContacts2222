const express = require('express');
const puppeteer = require('puppeteer');
const { createClient } = require('@supabase/supabase-js');
const cron = require('node-cron');
const winston = require('winston');
const cors = require('cors');
const helmet = require('helmet');
const compression = require('compression');
require('dotenv').config();

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
let currentBrowser = null;

// Optimized Puppeteer setup for maximum speed and reliability
async function setupBrowser() {
  try {
    const browser = await puppeteer.launch({
      headless: true,
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
        '--disable-images',
        '--disable-javascript',
        '--disable-background-timer-throttling',
        '--disable-backgrounding-occluded-windows',
        '--disable-renderer-backgrounding',
        '--disable-features=TranslateUI',
        '--disable-background-networking',
        '--disable-sync',
        '--disable-default-apps',
        '--fast-start',
        '--disable-web-security',
        '--window-size=1920,1080',
        '--user-agent=Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        '--disable-blink-features=AutomationControlled',
        '--disable-features=VizDisplayCompositor'
      ]
    });
    
    logger.info('Browser setup completed');
    return browser;
  } catch (error) {
    logger.error('Browser setup failed:', error);
    throw error;
  }
}

// Ultra-fast service details fetcher with improved reliability
async function fetchServiceDetails(page, circleCode, serviceNumber) {
  try {
    // Set realistic user agent and hide automation
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
    await page.evaluateOnNewDocument(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    });

    // Navigate with shorter timeout and better error handling
    await page.goto('https://tgsouthernpower.org/getUkscno', {
      waitUntil: 'domcontentloaded',
      timeout: 15000
    });

    // Wait for input field with retry logic
    let inputField;
    for (let i = 0; i < 3; i++) {
      try {
        inputField = await page.waitForSelector('#ukscno', { timeout: 3000 });
        break;
      } catch (error) {
        if (i === 2) throw error;
        await page.waitForTimeout(1000);
      }
    }

    // Clear and enter data with human-like typing
    await inputField.click();
    await inputField.evaluate(el => el.value = '');
    await page.type('#ukscno', `${circleCode} ${serviceNumber}`, { delay: 50 });

    // Find and click submit button with retry
    let submitButton;
    for (let i = 0; i < 3; i++) {
      try {
        submitButton = await page.$x("//button[contains(text(), 'Submit') or contains(text(), 'SUBMIT')]");
        if (submitButton.length > 0) {
          await submitButton[0].click();
          break;
        }
      } catch (error) {
        if (i === 2) throw error;
        await page.waitForTimeout(500);
      }
    }

    // Wait for results with shorter timeout
    await page.waitForTimeout(1000);

    // Extract service details with error handling
    const serviceDetails = await page.evaluate(() => {
      try {
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
      } catch (error) {
        return {
          serviceNo: '',
          uniqueServiceNo: 'Not Found',
          customerName: 'Not Found',
          address: 'Not Found',
          ero: 'Not Found',
          mobile: 'Not Found',
          status: 'Failed'
        };
      }
    });

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
      waitUntil: 'networkidle0',
      timeout: 10000
    });

    // Wait for input field and enter UKSCNO
    await page.waitForSelector('#ukscno', { timeout: 5000 });
    await page.type('#ukscno', ukscno, { delay: 0 });

    // Find and click submit button
    const submitButton = await page.$x("//button[contains(text(), 'Submit') or contains(text(), 'SUBMIT')]");
    if (submitButton.length > 0) {
      await submitButton[0].click();
    }

    // Wait for results
    await page.waitForTimeout(800);

    // Extract bill amount
    const billAmount = await page.evaluate(() => {
      const rows = document.querySelectorAll('table tr');
      for (let row of rows) {
        const cells = row.querySelectorAll('td');
        if (cells.length >= 2) {
          const amount = cells[1]?.textContent?.trim();
          if (amount && amount !== '') {
            return amount;
          }
        }
      }
      return 'Not Found';
    });

    return billAmount;
  } catch (error) {
    logger.error(`Error fetching bill amount for UKSCNO ${ukscno}:`, error);
    return 'Not Found';
  }
}

// Complete service processing
async function processService(page, circleCode, serviceNumber) {
  try {
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

// Save data to Supabase - Only save successful results
async function saveToSupabase(data) {
  try {
    // Only save if the service was found successfully
    if (data.status === 'Success' && data.uniqueServiceNo !== 'Not Found') {
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
          status: 'COMPLETED'
        }]);

      if (error) {
        logger.error('Supabase insert error:', error);
        return false;
      }
      logger.debug(`✅ Saved successful result for ${data.serviceNo}`);
      return true;
    } else {
      // Skip saving failed/invalid service numbers
      logger.debug(`⏭️ Skipping invalid service: ${data.serviceNo} (Status: ${data.status})`);
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
  const page = await browser.newPage();
  
  try {
    const maxNumber = Math.pow(10, digitsInServiceCode) - 1;
    let processedCount = 0;
    let successCount = 0;
    let savedCount = 0;

    for (let i = 0; i <= maxNumber; i++) {
      const serviceNumber = i.toString().padStart(digitsInServiceCode, '0');
      
      try {
        const result = await processService(page, circleCode, serviceNumber);
        const saved = await saveToSupabase(result);
        
        processedCount++;
        if (result.status === 'Success') {
          successCount++;
        }
        if (saved && result.status === 'Success') {
          savedCount++;
        }

        // Log progress every 50 services
        if (processedCount % 50 === 0) {
          logger.info(`Progress: ${processedCount}/${maxNumber + 1} (${successCount} found, ${savedCount} saved) for circle ${circleCode}`);
        }

        // Small delay to avoid overwhelming the server and reduce errors
        await page.waitForTimeout(200);

      } catch (error) {
        logger.error(`Error processing ${circleCode} ${serviceNumber}:`, error);
        processedCount++;
      }
    }

    logger.info(`✅ Completed circle ${circleCode}: ${processedCount} processed, ${successCount} found, ${savedCount} saved to database`);
    return { processedCount, successCount, savedCount };

  } catch (error) {
    logger.error(`Error in processCircleCode for ${circleCode}:`, error);
    throw error;
  } finally {
    await browser.close();
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
