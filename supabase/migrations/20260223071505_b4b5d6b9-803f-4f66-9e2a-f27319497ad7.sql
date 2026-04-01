
CREATE TABLE public.analysis_chunks (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  job_id text NOT NULL,
  chunk_index integer NOT NULL,
  chunk_data jsonb NOT NULL,
  result jsonb,
  status text DEFAULT 'pending',
  created_at timestamptz DEFAULT now()
);

ALTER TABLE public.analysis_chunks ENABLE ROW LEVEL SECURITY;

-- Service role access only (used by edge functions)
CREATE POLICY "Allow all access to analysis_chunks" ON public.analysis_chunks FOR ALL USING (true) WITH CHECK (true);

CREATE INDEX idx_analysis_chunks_job_id ON public.analysis_chunks(job_id);
CREATE INDEX idx_analysis_chunks_created_at ON public.analysis_chunks(created_at);
