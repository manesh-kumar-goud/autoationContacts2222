# 🚀 Complete Setup Guide - New TGSPDCL Automation Project

## 📋 **Step 1: Create New Supabase Project**

### **1.1 Go to Supabase Dashboard**
- Visit: [https://supabase.com/dashboard](https://supabase.com/dashboard)
- Sign in or create account

### **1.2 Create New Project**
- Click **"New Project"**
- Choose your organization
- Enter project details:
  - **Name**: `tgspdcl-automation` (or your preferred name)
  - **Database Password**: Create a strong password
  - **Region**: Choose closest to you
- Click **"Create new project"**
- Wait for project to be created (2-3 minutes)

### **1.3 Get Project Credentials**
- Go to **Settings** → **API**
- Copy these values:
  - **Project URL**: `https://your-project-id.supabase.co`
  - **anon public key**: `eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...`

## 🗄️ **Step 2: Create Database Tables**

### **2.1 Open SQL Editor**
- In your Supabase dashboard, go to **SQL Editor**
- Click **"New Query"**

### **2.2 Create Main Results Table**
Copy and paste this SQL:

```sql
-- TGSPDCL Automation Main Table
CREATE TABLE public.tgspdcl_automation_data (
    id BIGSERIAL PRIMARY KEY,
    service_no TEXT,
    unique_service_no TEXT,
    customer_name TEXT,
    address TEXT,
    ero TEXT,
    mobile TEXT,
    bill_amount TEXT,
    fetch_status TEXT,
    search_info JSONB,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    remarks TEXT,
    status TEXT DEFAULT 'PENDING'
);

-- Enable Row Level Security
ALTER TABLE public.tgspdcl_automation_data ENABLE ROW LEVEL SECURITY;

-- Create policy to allow all operations
CREATE POLICY "Enable all operations" ON public.tgspdcl_automation_data
FOR ALL USING (true);

-- Create indexes for better performance
CREATE INDEX idx_search_session ON public.tgspdcl_automation_data USING GIN (search_info);
CREATE INDEX idx_service_no ON public.tgspdcl_automation_data (service_no);
CREATE INDEX idx_fetch_status ON public.tgspdcl_automation_data (fetch_status);
CREATE INDEX idx_created_at ON public.tgspdcl_automation_data (created_at);

-- Verify table creation
SELECT 'TGSPDCL automation table created successfully!' as result;
```

Click **"Run"** to execute.

### **2.3 Create Circle Codes Table**
Create a new query and paste this SQL:

```sql
-- Circle Codes Table for TGSPDCL Automation
CREATE TABLE public.circle_codes (
    id BIGSERIAL PRIMARY KEY,
    circle_code TEXT NOT NULL,
    digits_in_service_code INTEGER NOT NULL,
    status TEXT DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'PROCESSING', 'COMPLETED', 'FAILED')),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    started_at TIMESTAMPTZ,
    completed_at TIMESTAMPTZ,
    total_services INTEGER,
    successful_services INTEGER,
    failed_services INTEGER,
    remarks TEXT
);

-- Enable Row Level Security
ALTER TABLE public.circle_codes ENABLE ROW LEVEL SECURITY;

-- Create policy to allow all operations
CREATE POLICY "Enable all operations" ON public.circle_codes
FOR ALL USING (true);

-- Create indexes for better performance
CREATE INDEX idx_circle_codes_status ON public.circle_codes (status);
CREATE INDEX idx_circle_codes_created_at ON public.circle_codes (created_at);
CREATE INDEX idx_circle_codes_circle_code ON public.circle_codes (circle_code);

-- Create trigger to update updated_at timestamp
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ language 'plpgsql';

CREATE TRIGGER update_circle_codes_updated_at 
    BEFORE UPDATE ON public.circle_codes 
    FOR EACH ROW 
    EXECUTE FUNCTION update_updated_at_column();

-- Verify table creation
SELECT 'Circle codes table created successfully!' as result;
```

Click **"Run"** to execute.

## 🔧 **Step 3: Setup Local Project**

### **3.1 Create Environment File**
Create `.env` file in your project root:

```bash
# Supabase Configuration
SUPABASE_URL=https://your-project-id.supabase.co
SUPABASE_KEY=your_anon_public_key_here

# Server Configuration
PORT=3000
NODE_ENV=production

# Logging Configuration
LOG_LEVEL=info

# Automation Configuration
AUTOMATION_INTERVAL=3600000  # 1 hour in milliseconds
MAX_CONCURRENT_PROCESSES=1
```

### **3.2 Install Dependencies**
```bash
npm install
```

### **3.3 Test Setup**
```bash
npm test
```

## 📊 **Step 4: Add Sample Circle Codes**

### **4.1 Add Test Data**
In Supabase SQL Editor, run:

```sql
-- Add sample circle codes for testing
INSERT INTO circle_codes (circle_code, digits_in_service_code, status) VALUES
('1213', 3, 'PENDING'),
('1214', 4, 'PENDING'),
('1215', 5, 'PENDING'),
('12234', 6, 'PENDING'),
('99999', 3, 'PENDING');

-- Verify data
SELECT * FROM circle_codes ORDER BY created_at DESC;
```

## 🚀 **Step 5: Start Automation**

### **5.1 Start Server**
```bash
npm start
```

### **5.2 Test API Endpoints**
```bash
# Health check
curl http://localhost:3000/

# Check status
curl http://localhost:3000/status

# Check pending circle codes
curl http://localhost:3000/check-pending

# Get statistics
curl http://localhost:3000/stats

# Start automation manually
curl -X POST http://localhost:3000/start-automation
```

## ✅ **Step 6: Verify Everything Works**

### **6.1 Check Database Tables**
```sql
-- Check if tables exist
SELECT table_name FROM information_schema.tables 
WHERE table_schema = 'public' 
AND table_name IN ('tgspdcl_automation_data', 'circle_codes');

-- Check circle codes
SELECT * FROM circle_codes;

-- Check results (after processing)
SELECT COUNT(*) as total_processed FROM tgspdcl_automation_data;
```

### **6.2 Monitor Logs**
- Check console output for processing logs
- Look for `combined.log` and `error.log` files

## 🎯 **Next Steps**

1. **Add Your Circle Codes**: Insert your actual circle codes into the database
2. **Continuous Monitoring**: The system automatically checks for new pending tasks every 5 minutes
3. **Deploy to Render**: Follow `RENDER_DEPLOYMENT.md` for cloud deployment
4. **Monitor Progress**: Check logs and database for processing status
5. **Scale Up**: Add more circle codes as needed

## 🔄 **Continuous Processing**

### **How It Works:**
- **Automatic Monitoring**: Checks for new pending tasks every 5 minutes
- **Continuous Processing**: When all pending tasks are completed, it waits for new ones
- **Real-time Response**: New circle codes are processed automatically when added
- **No Manual Intervention**: Once started, the system runs continuously

### **Adding New Circle Codes:**
```sql
-- Add new circle codes anytime
INSERT INTO circle_codes (circle_code, digits_in_service_code) VALUES
('12345', 4, 'PENDING'),
('67890', 5, 'PENDING');

-- The system will automatically detect and process them
```

## 🛠️ **Troubleshooting**

### **Common Issues:**

1. **Database Connection Failed**
   - Check Supabase URL and key in `.env`
   - Verify project is active in Supabase dashboard

2. **Tables Not Found**
   - Run the SQL scripts again
   - Check for any error messages in SQL Editor

3. **Puppeteer Issues**
   - Ensure Chrome is installed
   - Check internet connection

4. **Memory Issues**
   - Reduce batch size in server.js
   - Increase system memory

---

**Your new TGSPDCL automation project is ready!** 🚀
