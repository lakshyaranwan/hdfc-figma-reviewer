-- Add INSERT and UPDATE policies for app_settings table
-- This allows anyone to update shared app settings like AI model selection and usage stats

CREATE POLICY "Allow public insert access to settings" 
ON public.app_settings 
FOR INSERT 
WITH CHECK (true);

CREATE POLICY "Allow public update access to settings" 
ON public.app_settings 
FOR UPDATE 
USING (true);