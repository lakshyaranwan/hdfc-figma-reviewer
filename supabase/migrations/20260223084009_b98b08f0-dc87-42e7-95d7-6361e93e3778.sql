
CREATE TABLE public.plugin_usage (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  user_name text NOT NULL DEFAULT 'anonymous',
  action text NOT NULL DEFAULT 'analyze',
  node_count integer DEFAULT 0,
  category_count integer DEFAULT 0
);

ALTER TABLE public.plugin_usage ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Anyone can insert usage" ON public.plugin_usage FOR INSERT WITH CHECK (true);
CREATE POLICY "Anyone can view usage" ON public.plugin_usage FOR SELECT USING (true);

CREATE INDEX idx_plugin_usage_created_at ON public.plugin_usage (created_at);
CREATE INDEX idx_plugin_usage_user_name ON public.plugin_usage (user_name);
