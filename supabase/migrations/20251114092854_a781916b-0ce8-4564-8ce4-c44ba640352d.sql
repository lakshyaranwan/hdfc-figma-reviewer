-- Create a simple settings table to initialize the database
CREATE TABLE IF NOT EXISTS public.app_settings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  key TEXT UNIQUE NOT NULL,
  value TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Enable RLS
ALTER TABLE public.app_settings ENABLE ROW LEVEL SECURITY;

-- Create a policy to allow reading settings
CREATE POLICY "Allow public read access to settings"
  ON public.app_settings
  FOR SELECT
  USING (true);