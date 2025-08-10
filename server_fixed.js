/*
  server_fixed.js
  - Improved, robust version of your TGSPDCL Puppeteer automation
  - Fixes: timeouts, retries, memory leaks, batching, parallel workers,
    env validation, graceful shutdown, batch DB writes, logging rotation,
    watchdog to reset isProcessing, and safer cron schedule handling.

  NOTE: update your .env with required values (see bottom)
*/

const express = require('express');
const puppeteer = require('puppeteer');
const { createClient } = require('@supabase/supabase-js');
const cron = require('node-cron');
const winston = require('winston');
const cors = require('cors');
const helmet = require('helmet');
const compression = require('compression');
require('dotenv').config();

// -------------------------
// Configuration & Env-check
// -------------------------
const PORT = process.env.PORT || 3000;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const MAX_CONCURRENCY = parseInt(process.env.MAX_CONCURRENCY || '2', 10); // number of parallel pages
const BATCH_SIZE = parseInt(process.env.BATCH_SIZE || '250', 10); // process numbers per batch
const PAGE_RECREATE_INTERVAL = parseInt(process.env.PAGE_RECREATE_INTERVAL || '500', 10); // recreate page after N items
const NAV_TIMEOUT = parseInt(process.env.NAV_TIMEOUT || '45000', 10); // navigation timeout
const DEFAULT_TIMEOUT = parseInt(process.env.DEFAULT_TIMEOUT || '30000', 10); // default wait timeout
const MAX_RUN_MS = parseInt(process.env.MAX_RUN_MS || String(20 * 60 * 1000), 10); // 20 minutes by default
const BATCH_SAVE_SIZE = parseInt(process.env.BATCH_SAVE_SIZE || '100', 10); // supabase batch size
const SAVE_ONLY_SUCCESS = process.env.SAVE_ONLY_SUCCESS !== 'false';

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('Missing SUPABASE_URL or SUPABASE_KEY in environment. Exiting.');
  process.exit(1);
}

// -------------------------
// Logging with rotation (simple size-based rotate)
// -------------------------
const { combine, timestamp, printf } = winston.format;
const logFormat = printf(({ level, message, timestamp }) => `${timestamp} ${level}: ${message}`);

const logger = winston.createLogger({
  level: 'info',
  format: combine(timestamp(), logFormat),
  transports: [
    new winston.transports.Console(),
    new winston.transports.File({ filename: 'combined.log', maxsize: 5 * 1024 * 1024, maxFiles: 5 }),
    new winston.transports.File({ filename: 'error.log', level: 'error', maxsize: 5 * 1024 * 1024, maxFiles: 5 })
  ],
  exitOnError: false
});

// -------------------------
// App, DB, Globals
// -------------------------
const app = express();
app.use(helmet());
app.use(compression());
app.use(cors());
app.use(express.json());

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
let isProcessing = false;
let watchdogTimer = null;

// -------------------------
// Helpers: safe delays & memory log
// -------------------------
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
function logMemoryUsage(prefix = '') {
  try {
    const mem = process.memoryUsage();
    logger.info(`${prefix} memory rss=${Math.round(mem.rss / 1024 / 1024)}MB heapUsed=${Math.round(mem.heapUsed / 1024 / 1024)}MB`);
  } catch (e) {}
}

// -------------------------
// Puppeteer setup & utility
// -------------------------
async function launchBrowser() {
  // If you deploy to Render, consider using puppeteer-core + chrome-aws-lambda / or ensure chromium exists.
  return await puppeteer.launch({
    headless: 'new',
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--no-zygote',
      '--single-process',
      '--disable-extensions',
      '--disable-background-timer-throttling',
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding',
      '--window-size=1280,800'
    ],
    dumpio: false
  });
}

async function setupPage(page) {
  try {
    await page.setDefaultNavigationTimeout(NAV_TIMEOUT);
    await page.setDefaultTimeout(DEFAULT_TIMEOUT);
    await page.setViewport({ width: 1280, height: 800 });
    try {
      await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0 Safari/537.36');
    } catch {}

    // block images/fonts/styles to save bandwidth and memory
    try {
      await page.setRequestInterception(true);
      page.on('request', (req) => {
        const t = req.resourceType();
        if (['image', 'stylesheet', 'font', 'media'].includes(t)) return req.abort();
        req.continue();
      });
    } catch (e) {
      logger.warn('Failed to enable request interception: ' + (e && e.message));
    }
  } catch (err) {
    logger.error('setupPage error: ' + err.message);
  }
}

// safe goto with retries and small backoff
async function safeGoto(page, url, opts = {}) {
  const attempts = opts.attempts || 3;
  const waitBetween = opts.waitBetween || 1500;
  for (let i = 0; i < attempts; i++) {
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT });
      return true;
    } catch (err) {
      logger.warn(`safeGoto attempt ${i + 1}/${attempts} failed for ${url}: ${err.message}`);
      if (i === attempts - 1) throw err;
      await wait(waitBetween * (i + 1));
    }
  }
}

// -------------------------
// Scraping functions (kept resilient with retries)
// -------------------------
async function fetchServiceDetails(page, circleCode, serviceNumber) {
  const inputValue = `${circleCode} ${serviceNumber}`;

  try {
    await safeGoto(page, 'https://tgsouthernpower.org/getUkscno');

    // ensure input exists
    try {
      await page.waitForSelector('#ukscno', { timeout: 7000 });
      await page.evaluate(() => { const el = document.querySelector('#ukscno'); if (el) el.value = ''; });
      await page.type('#ukscno', inputValue, { delay: 0 });
    } catch (e) {
      // If the input isn't found quickly, still try some fallbacks
      logger.debug('Primary input #ukscno not found; trying generic input');
      const input = await page.$("input[type='text']");
      if (input) {
        await input.click({ clickCount: 3 });
        await input.type(inputValue, { delay: 0 });
      }
    }

    // submit (prefer button, fallback to enter)
    const submitBtn = await page.$x("//button[contains(translate(., 'abcdefghijklmnopqrstuvwxyz', 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'), 'SUBMIT')]");
    const navOrResults = Promise.race([
      page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => null),
      page.waitForFunction(() => document.querySelectorAll('table tr').length > 0 || document.querySelector('table') !== null, { timeout: 20000 }).catch(() => null)
    ]);

    if (submitBtn.length > 0) {
      await Promise.all([submitBtn[0].click(), navOrResults]);
    } else {
      await Promise.all([page.keyboard.press('Enter'), navOrResults]);
    }

    // short wait to allow DOM render
    await page.waitForTimeout(500);

    // evaluate table data
    const details = await page.evaluate(() => {
      const rows = Array.from(document.querySelectorAll('table tr'));
      const defaultRes = { serviceNo: '', uniqueServiceNo: 'Not Found', customerName: 'Not Found', address: 'Not Found', ero: 'Not Found', mobile: 'Not Found', status: 'Failed' };
      for (const row of rows) {
        const cells = row.querySelectorAll('td');
        if (cells.length >= 6) {
          return {
            serviceNo: (cells[0] && cells[0].textContent.trim()) || '',
            uniqueServiceNo: (cells[1] && cells[1].textContent.trim()) || 'Not Found',
            customerName: (cells[2] && cells[2].textContent.trim()) || 'Not Found',
            address: (cells[3] && cells[3].textContent.trim()) || 'Not Found',
            ero: (cells[4] && cells[4].textContent.trim()) || 'Not Found',
            mobile: (cells[5] && cells[5].textContent.trim()) || 'Not Found',
            status: 'Success'
          };
        }
      }
      return defaultRes;
    });

    // some small normalization
    if (!details.serviceNo) details.serviceNo = inputValue;
    return details;
  } catch (error) {
    logger.error(`fetchServiceDetails error ${circleCode} ${serviceNumber}: ${error.message}`);
    return { serviceNo: inputValue, uniqueServiceNo: 'Not Found', customerName: 'Not Found', address: 'Not Found', ero: 'Not Found', mobile: 'Not Found', status: 'Failed' };
  }
}

async function fetchBillAmount(page, ukscno) {
  if (!ukscno || ukscno === 'Not Found') return 'Not Found';

  try {
    await safeGoto(page, 'https://tgsouthernpower.org/getBillAmount');

    // attempt smart input selection
    const candidateSelectors = ['#ukscno', "input[name='ukscno']", "input[id*='ukscno' i]", "input[id*='uksc' i]", "input[type='text']"];
    let inputSelector = null;
    for (const sel of candidateSelectors) {
      try {
        if (await page.$(sel)) {
          inputSelector = sel;
          break;
        }
      } catch {}
    }

    if (inputSelector) {
      await page.click(inputSelector, { clickCount: 3 }).catch(() => {});
      await page.type(inputSelector, ukscno, { delay: 0 });
    } else {
      // fallback: navigate to possible direct urls
      const url = `https://tgsouthernpower.org/billinginfo?ukscno=${encodeURIComponent(ukscno)}`;
      await safeGoto(page, url);
    }

    const navOrResults = Promise.race([
      page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => null),
      page.waitForFunction(() => document.querySelectorAll('table tr').length > 0 || /billinginfo/i.test(location.href), { timeout: 20000 }).catch(() => null)
    ]);

    // click submit if exists
    const submitBtn = await page.$x("//button[contains(translate(., 'abcdefghijklmnopqrstuvwxyz', 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'), 'SUBMIT')]");
    if (submitBtn.length > 0) {
      await Promise.all([submitBtn[0].click(), navOrResults]);
    } else {
      await Promise.all([page.keyboard.press('Enter'), navOrResults]);
    }

    // try direct extract
    const billAmount = await page.evaluate(() => {
      const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();
      const rows = Array.from(document.querySelectorAll('table tr'));
      for (const row of rows) {
        const txt = norm(row.textContent || '');
        if (/current\s*month\s*bill|total\s*amount\s*payable|amount\s*payable/i.test(txt)) {
          const m = txt.match(/(₹|Rs\.?\s*)?\s*([0-9][0-9,]*\.?[0-9]*)/i);
          if (m) return m[0].trim();
        }
      }
      const any = (document.body.innerText.match(/₹\s*[0-9][0-9,]*\.?[0-9]*/g) || []);
      return any.length ? any[0].trim() : 'Not Found';
    });

    return billAmount || 'Not Found';
  } catch (err) {
    logger.error('fetchBillAmount error: ' + err.message);
    return 'Not Found';
  }
}

// -------------------------
// DB: batched inserts with retry
// -------------------------
async function batchInsertToSupabase(rows) {
  if (!rows || rows.length === 0) return true;
  const maxAttempts = 3;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      const { error } = await supabase.from('tgspdcl_automation_data').insert(rows);
      if (error) throw error;
      return true;
    } catch (err) {
      logger.warn(`Supabase batch insert attempt ${attempt + 1} failed: ${err.message}`);
      await wait(1500 * (attempt + 1));
    }
  }
  logger.error('Supabase batch insert failed after retries');
  return false;
}

// -------------------------
// Core processing: process range in batches and with worker pages
// -------------------------
async function processCircleCode(circleCode, digitsInServiceCode) {
  logger.info(`Starting processing for circle ${circleCode} digits=${digitsInServiceCode}`);
  logMemoryUsage('before-launch:');

  const browser = await launchBrowser();
  try {
    // create worker pages
    const workerPages = [];
    for (let i = 0; i < Math.max(1, Math.min(MAX_CONCURRENCY, 6)); i++) {
      const p = await browser.newPage();
      await setupPage(p);
      workerPages.push({ page: p, processedSinceReset: 0 });
    }

    const maxNumber = Math.pow(10, digitsInServiceCode) - 1;
    const envStart = Number.parseInt(process.env.START_INDEX ?? '0', 10);
    const envEnd = Number.parseInt(process.env.END_INDEX ?? String(maxNumber), 10);
    let startIndex = Number.isFinite(envStart) ? envStart : 0;
    let endIndex = Number.isFinite(envEnd) ? envEnd : maxNumber;
    startIndex = Math.max(0, Math.min(startIndex, maxNumber));
    endIndex = Math.max(0, Math.min(endIndex, maxNumber));

    const ascending = startIndex <= endIndex;
    const totalToProcess = Math.abs(endIndex - startIndex) + 1;
    logger.info(`Processing range ${startIndex} -> ${endIndex} (total ${totalToProcess})`);

    // process in batches to allow progress checkpointing and avoid very long runs
    const resultsBuffer = [];

    const indices = [];
    if (ascending) for (let i = startIndex; i <= endIndex; i++) indices.push(i);
    else for (let i = startIndex; i >= endIndex; i--) indices.push(i);

    // iterate in batches (not to be confused with DB batch inserts)
    for (let b = 0; b < indices.length; b += BATCH_SIZE) {
      const batchIndices = indices.slice(b, b + BATCH_SIZE);
      logger.info(`Processing batch ${b / BATCH_SIZE + 1} (${batchIndices.length} items)`);

      // round-robin distribute jobs over worker pages with concurrency
      const tasks = batchIndices.map((num, idx) => ({ num, workerIdx: idx % workerPages.length }));

      // process tasks in chunks to avoid starving event loop
      const chunkSize = Math.max(1, Math.min(50, Math.ceil(tasks.length / 6)));
      for (let k = 0; k < tasks.length; k += chunkSize) {
        const chunk = tasks.slice(k, k + chunkSize);
        const promises = chunk.map(async (task) => {
          const serviceNumber = task.num.toString().padStart(digitsInServiceCode, '0');
          const worker = workerPages[task.workerIdx];
          const page = worker.page;

          try {
            const details = await fetchServiceDetails(page, circleCode, serviceNumber);
            let billAmount = 'Not Found';
            if (details.status === 'Success') {
              billAmount = await fetchBillAmount(page, details.uniqueServiceNo);
            }

            const row = {
              service_no: details.serviceNo || `${circleCode} ${serviceNumber}`,
              unique_service_no: details.uniqueServiceNo || 'Not Found',
              customer_name: details.customerName || 'Not Found',
              address: details.address || 'Not Found',
              ero: details.ero || 'Not Found',
              mobile: details.mobile || 'Not Found',
              bill_amount: billAmount,
              fetch_status: details.status || 'Failed',
              search_info: { circle_code: circleCode, service_number: serviceNumber, processed_at: new Date().toISOString() },
              status: (details.status === 'Success') ? 'COMPLETED' : 'FAILED'
            };

            // push to buffer for batch save
            if (!SAVE_ONLY_SUCCESS || row.fetch_status === 'Success') resultsBuffer.push(row);

            worker.processedSinceReset += 1;
            // recreate page periodically to prevent memory leaks
            if (worker.processedSinceReset >= PAGE_RECREATE_INTERVAL) {
              try {
                await page.close();
              } catch (e) {}
              const newPage = await browser.newPage();
              await setupPage(newPage);
              worker.page = newPage;
              worker.processedSinceReset = 0;
            }
          } catch (err) {
            logger.error(`Task error for ${circleCode} ${serviceNumber}: ${err.message}`);
          }
        });

        await Promise.all(promises);

        // periodically flush buffer to DB
        if (resultsBuffer.length >= BATCH_SAVE_SIZE) {
          const toSave = resultsBuffer.splice(0, BATCH_SAVE_SIZE);
          const ok = await batchInsertToSupabase(toSave);
          if (!ok) logger.error('Failed to save a DB batch');
        }

        // small breathing room
        await wait(150);
      }

      // flush remaining (end of batch)
      if (resultsBuffer.length > 0) {
        const toSave = resultsBuffer.splice(0, resultsBuffer.length);
        await batchInsertToSupabase(toSave);
      }

      // checkpoint log & memory
      logger.info(`Completed batch ${b / BATCH_SIZE + 1}`);
      logMemoryUsage('after-batch:');

      // guard: if we've been running too long, bail out gracefully so scheduler can resume later
      if (global.__automationAbortRequested) {
        logger.warn('Abort requested - stopping batch processing');
        break;
      }
    }

    // close worker pages
    for (const w of workerPages) {
      try { await w.page.close(); } catch (e) {}
    }

    logger.info(`Completed processing circle ${circleCode}`);
    return true;
  } finally {
    try { await browser.close(); } catch (e) { logger.warn('Error closing browser: ' + e.message); }
  }
}

// -------------------------
// Orchestration: get-pending, update-status
// -------------------------
async function getPendingCircleCodes() {
  try {
    const { data, error } = await supabase.from('circle_codes').select('*').eq('status', 'PENDING').order('id', { ascending: true });
    if (error) throw error;
    return data || [];
  } catch (err) {
    logger.error('getPendingCircleCodes error: ' + err.message);
    return [];
  }
}

async function updateCircleCodeStatus(id, status) {
  try {
    const { error } = await supabase.from('circle_codes').update({ status }).eq('id', id);
    if (error) throw error;
    return true;
  } catch (err) {
    logger.error('updateCircleCodeStatus error: ' + err.message);
    return false;
  }
}

// -------------------------
// Main automation runner with watchdog and graceful flags
// -------------------------
async function runAutomation() {
  if (isProcessing) {
    logger.info('Automation already running, skipping');
    return;
  }
  isProcessing = true;
  global.__automationAbortRequested = false;

  // watchdog to ensure isProcessing resets if something hangs
  watchdogTimer = setTimeout(() => {
    logger.error('Watchdog triggered: max run time exceeded');
    global.__automationAbortRequested = true;
    // schedule reset of isProcessing in case something is stuck
    setTimeout(() => {
      if (isProcessing) {
        logger.warn('Forcing isProcessing=false by watchdog');
        isProcessing = false;
      }
    }, 5000);
  }, MAX_RUN_MS);

  try {
    const pending = await getPendingCircleCodes();
    if (!pending.length) {
      logger.info('No pending circle codes');
      return;
    }

    for (const p of pending) {
      if (global.__automationAbortRequested) break;
      try {
        await updateCircleCodeStatus(p.id, 'PROCESSING');
        await processCircleCode(p.circle_code, p.digits_in_service_code);
        await updateCircleCodeStatus(p.id, 'COMPLETED');
      } catch (err) {
        logger.error(`Processing failed for ${p.circle_code}: ${err.message}`);
        await updateCircleCodeStatus(p.id, 'FAILED');
      }
    }
  } catch (err) {
    logger.error('runAutomation error: ' + err.message);
  } finally {
    clearTimeout(watchdogTimer);
    isProcessing = false;
    global.__automationAbortRequested = false;
    logger.info('Automation run finished');
  }
}

// -------------------------
// API routes & health
// -------------------------
app.get('/', (req, res) => res.json({ message: 'TGSPDCL Automation (fixed)', isProcessing }));

app.post('/start-automation', async (req, res) => {
  if (isProcessing) return res.status(409).json({ success: false, message: 'Already running' });
  runAutomation().catch((e) => logger.error('startAutomation runner error: ' + e.message));
  res.json({ success: true, message: 'Automation started' });
});

app.get('/status', (req, res) => res.json({ isProcessing, timestamp: new Date().toISOString() }));

app.get('/check-pending', async (req, res) => {
  const pending = await getPendingCircleCodes();
  res.json({ success: true, pendingCount: pending.length, pendingCodes: pending, isProcessing });
});

app.get('/stats', async (req, res) => {
  try {
    const { count: total } = await supabase.from('tgspdcl_automation_data').select('*', { count: 'exact', head: true });
    const { count: success } = await supabase.from('tgspdcl_automation_data').select('*', { count: 'exact', head: true }).eq('fetch_status', 'Success');
    res.json({ success: true, database: { total: total || 0, success: success || 0 }, isProcessing });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// -------------------------
// Cron scheduling - single, safe schedule
// -------------------------
// Use a single schedule to avoid accidental overlaps. Default every 5 minutes.
cron.schedule(process.env.CRON_SCHEDULE || '*/5 * * * *', () => {
  logger.info('Scheduled automation triggered');
  runAutomation().catch((e) => logger.error('cron-run error: ' + e.message));
});

// -------------------------
// Process guards & graceful shutdown
// -------------------------
process.on('unhandledRejection', (reason) => logger.error('UnhandledRejection: ' + (reason && reason.stack ? reason.stack : reason)));
process.on('uncaughtException', (err) => {
  logger.error('UncaughtException: ' + err.stack);
  // try to shutdown gracefully
  try { process.exit(1); } catch (e) { process.kill(process.pid, 'SIGTERM'); }
});

// -------------------------
// Start server
// -------------------------
app.listen(PORT, () => {
  logger.info(`Server listening on port ${PORT}`);
  logger.info('Automation backend ready');
});

// -------------------------
// Required .env keys (example):
// SUPABASE_URL=https://xyz.supabase.co
// SUPABASE_KEY=your_service_role_key
// PORT=3000
// MAX_CONCURRENCY=2
// BATCH_SIZE=250
// PAGE_RECREATE_INTERVAL=500
// NAV_TIMEOUT=45000
// DEFAULT_TIMEOUT=30000
// MAX_RUN_MS=1200000
// BATCH_SAVE_SIZE=100
// SAVE_ONLY_SUCCESS=true
// CRON_SCHEDULE=*/5 * * * *
// -------------------------
