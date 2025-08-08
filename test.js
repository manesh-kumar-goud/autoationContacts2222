#!/usr/bin/env node
/**
 * Test script for TGSPDCL Node.js Automation
 * This script tests the core functionality
 */

const { createClient } = require('@supabase/supabase-js');
const puppeteer = require('puppeteer');
require('dotenv').config();

// Initialize Supabase
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY;

if (!supabaseUrl || !supabaseKey) {
  console.error('❌ Supabase credentials not found in .env file');
  console.log('Please create .env file with:');
  console.log('SUPABASE_URL=your_supabase_url');
  console.log('SUPABASE_KEY=your_supabase_key');
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey);

async function testSupabaseConnection() {
  console.log('🔍 Testing Supabase connection...');
  
  try {
    // Test basic connection
    const { data, error } = await supabase
      .from('circle_codes')
      .select('count')
      .limit(1);
    
    if (error) {
      console.error('❌ Supabase connection failed:', error.message);
      return false;
    }
    
    console.log('✅ Supabase connection successful');
    return true;
  } catch (error) {
    console.error('❌ Supabase connection error:', error.message);
    return false;
  }
}

async function testTablesExist() {
  console.log('🔍 Testing database tables...');
  
  const tables = ['circle_codes', 'tgspdcl_automation_data'];
  
  for (const table of tables) {
    try {
      const { data, error } = await supabase
        .from(table)
        .select('*')
        .limit(1);
      
      if (error) {
        console.error(`❌ Table '${table}' not found or inaccessible`);
        return false;
      }
      
      console.log(`✅ Table '${table}' exists and accessible`);
    } catch (error) {
      console.error(`❌ Error accessing table '${table}':`, error.message);
      return false;
    }
  }
  
  return true;
}

async function testPuppeteer() {
  console.log('🔍 Testing Puppeteer...');
  
  let browser;
  try {
    browser = await puppeteer.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage'
      ]
    });
    
    const page = await browser.newPage();
    await page.goto('https://tgsouthernpower.org/getUkscno', {
      waitUntil: 'networkidle0',
      timeout: 10000
    });
    
    console.log('✅ Puppeteer test successful - TGSPDCL website accessible');
    return true;
  } catch (error) {
    console.error('❌ Puppeteer test failed:', error.message);
    return false;
  } finally {
    if (browser) {
      await browser.close();
    }
  }
}

async function testSampleData() {
  console.log('🔍 Testing sample data insertion...');
  
  try {
    // Test inserting a sample circle code
    const { data, error } = await supabase
      .from('circle_codes')
      .insert([{
        circle_code: 'TEST',
        digits_in_service_code: 3,
        status: 'PENDING'
      }])
      .select();
    
    if (error) {
      console.error('❌ Sample data insertion failed:', error.message);
      return false;
    }
    
    console.log('✅ Sample data insertion successful');
    
    // Clean up test data
    await supabase
      .from('circle_codes')
      .delete()
      .eq('circle_code', 'TEST');
    
    console.log('✅ Test data cleaned up');
    return true;
  } catch (error) {
    console.error('❌ Sample data test failed:', error.message);
    return false;
  }
}

async function showCircleCodes() {
  console.log('🔍 Checking existing circle codes...');
  
  try {
    const { data, error } = await supabase
      .from('circle_codes')
      .select('*')
      .order('created_at', { ascending: false });
    
    if (error) {
      console.error('❌ Error fetching circle codes:', error.message);
      return;
    }
    
    if (data && data.length > 0) {
      console.log('📋 Existing circle codes:');
      data.forEach(code => {
        console.log(`  - ${code.circle_code} (${code.digits_in_service_code} digits) - ${code.status}`);
      });
    } else {
      console.log('📋 No circle codes found. Add some using:');
      console.log(`
INSERT INTO circle_codes (circle_code, digits_in_service_code) VALUES
('1213', 3),
('1214', 3),
('1215', 3);
      `);
    }
  } catch (error) {
    console.error('❌ Error showing circle codes:', error.message);
  }
}

async function runAllTests() {
  console.log('🚀 Starting TGSPDCL Node.js Automation Tests');
  console.log('=' .repeat(50));
  
  const tests = [
    { name: 'Supabase Connection', fn: testSupabaseConnection },
    { name: 'Database Tables', fn: testTablesExist },
    { name: 'Puppeteer Setup', fn: testPuppeteer },
    { name: 'Sample Data', fn: testSampleData }
  ];
  
  let allPassed = true;
  
  for (const test of tests) {
    console.log(`\n🧪 Running: ${test.name}`);
    const result = await test.fn();
    if (!result) {
      allPassed = false;
    }
  }
  
  console.log('\n' + '=' .repeat(50));
  
  if (allPassed) {
    console.log('🎉 All tests passed! Your setup is ready.');
    console.log('\n📋 Next steps:');
    console.log('1. Add circle codes to the database');
    console.log('2. Run: npm start');
    console.log('3. Monitor logs for automation progress');
  } else {
    console.log('❌ Some tests failed. Please fix the issues above.');
  }
  
  console.log('\n📊 Current Status:');
  await showCircleCodes();
}

// Run tests if this file is executed directly
if (require.main === module) {
  runAllTests().catch(console.error);
}

module.exports = {
  testSupabaseConnection,
  testTablesExist,
  testPuppeteer,
  testSampleData,
  showCircleCodes
};
