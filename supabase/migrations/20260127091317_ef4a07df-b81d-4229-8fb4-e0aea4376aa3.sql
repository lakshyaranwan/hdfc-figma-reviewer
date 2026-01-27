-- Create a table for plugin feedback/suggestions
CREATE TABLE public.plugin_feedback (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_name TEXT NOT NULL,
  feedback TEXT NOT NULL,
  feedback_type TEXT NOT NULL DEFAULT 'suggestion',
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- Enable Row Level Security
ALTER TABLE public.plugin_feedback ENABLE ROW LEVEL SECURITY;

-- Allow anyone to insert feedback (plugin users)
CREATE POLICY "Anyone can insert feedback" 
ON public.plugin_feedback 
FOR INSERT 
WITH CHECK (true);

-- Allow anyone to view feedback
CREATE POLICY "Anyone can view feedback" 
ON public.plugin_feedback 
FOR SELECT 
USING (true);