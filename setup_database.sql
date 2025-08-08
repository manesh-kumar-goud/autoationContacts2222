-- Complete Database Setup for TGSPDCL Automation
-- Run this script in your Supabase SQL Editor

-- Step 1: Create Main Results Table
CREATE TABLE IF NOT EXISTS public.tgspdcl_automation_data (
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
DROP POLICY IF EXISTS "Enable all operations" ON public.tgspdcl_automation_data;
CREATE POLICY "Enable all operations" ON public.tgspdcl_automation_data
FOR ALL USING (true);

-- Create indexes for better performance
CREATE INDEX IF NOT EXISTS idx_search_session ON public.tgspdcl_automation_data USING GIN (search_info);
CREATE INDEX IF NOT EXISTS idx_service_no ON public.tgspdcl_automation_data (service_no);
CREATE INDEX IF NOT EXISTS idx_fetch_status ON public.tgspdcl_automation_data (fetch_status);
CREATE INDEX IF NOT EXISTS idx_created_at ON public.tgspdcl_automation_data (created_at);

-- Step 2: Create Circle Codes Table
CREATE TABLE IF NOT EXISTS public.circle_codes (
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
DROP POLICY IF EXISTS "Enable all operations" ON public.circle_codes;
CREATE POLICY "Enable all operations" ON public.circle_codes
FOR ALL USING (true);

-- Create indexes for better performance
CREATE INDEX IF NOT EXISTS idx_circle_codes_status ON public.circle_codes (status);
CREATE INDEX IF NOT EXISTS idx_circle_codes_created_at ON public.circle_codes (created_at);
CREATE INDEX IF NOT EXISTS idx_circle_codes_circle_code ON public.circle_codes (circle_code);

-- Create trigger to update updated_at timestamp
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ language 'plpgsql';

DROP TRIGGER IF EXISTS update_circle_codes_updated_at ON public.circle_codes;
CREATE TRIGGER update_circle_codes_updated_at 
    BEFORE UPDATE ON public.circle_codes 
    FOR EACH ROW 
    EXECUTE FUNCTION update_updated_at_column();

-- Step 3: Add Sample Data
INSERT INTO circle_codes (circle_code, digits_in_service_code, status) VALUES
('1213', 3, 'PENDING'),
('1214', 4, 'PENDING'),
('1215', 5, 'PENDING'),
('12234', 6, 'PENDING'),
('99999', 3, 'PENDING')
ON CONFLICT DO NOTHING;

-- Step 4: Verify Setup
SELECT 'Database setup completed successfully!' as status;
SELECT 'Tables created:' as info;
SELECT table_name FROM information_schema.tables 
WHERE table_schema = 'public' 
AND table_name IN ('tgspdcl_automation_data', 'circle_codes');

SELECT 'Sample circle codes:' as info;
SELECT * FROM circle_codes ORDER BY created_at DESC;
