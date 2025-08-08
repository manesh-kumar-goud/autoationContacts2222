-- Circle Codes Table for TGSPDCL Automation
-- This table stores circle codes and their processing status

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

-- Insert sample data
INSERT INTO public.circle_codes (circle_code, digits_in_service_code, status) VALUES
('1213', 3, 'PENDING'),
('1214', 3, 'PENDING'),
('1215', 3, 'PENDING'),
('1216', 3, 'PENDING'),
('1217', 3, 'PENDING');

-- Verify table creation
SELECT 'Circle codes table created successfully!' as result;
