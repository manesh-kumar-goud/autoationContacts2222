-- TGSPDCL Automation Main Table
-- Copy and paste this entire script into Supabase SQL Editor

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