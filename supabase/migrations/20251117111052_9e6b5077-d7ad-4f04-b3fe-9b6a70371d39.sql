-- Create table for shared API keys
CREATE TABLE public.shared_api_keys (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_name TEXT NOT NULL,
  figma_api_key TEXT NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- Enable Row Level Security
ALTER TABLE public.shared_api_keys ENABLE ROW LEVEL SECURITY;

-- Create public access policies (anyone can read, insert, update, delete)
CREATE POLICY "Anyone can view shared API keys" 
ON public.shared_api_keys 
FOR SELECT 
USING (true);

CREATE POLICY "Anyone can insert shared API keys" 
ON public.shared_api_keys 
FOR INSERT 
WITH CHECK (true);

CREATE POLICY "Anyone can update shared API keys" 
ON public.shared_api_keys 
FOR UPDATE 
USING (true);

CREATE POLICY "Anyone can delete shared API keys" 
ON public.shared_api_keys 
FOR DELETE 
USING (true);

-- Create trigger for automatic timestamp updates
CREATE TRIGGER update_shared_api_keys_updated_at
BEFORE UPDATE ON public.shared_api_keys
FOR EACH ROW
EXECUTE FUNCTION public.update_updated_at_column();

-- Enable realtime for this table
ALTER TABLE public.shared_api_keys REPLICA IDENTITY FULL;
ALTER PUBLICATION supabase_realtime ADD TABLE public.shared_api_keys;