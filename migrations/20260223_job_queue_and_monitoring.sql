-- Job queue + monitoring migration
-- Safe to run multiple times.

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- =============================================================
-- Queue table used by async generation flow
-- =============================================================
CREATE TABLE IF NOT EXISTS generation_jobs (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,
  status VARCHAR(20) NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'processing', 'completed', 'failed')),
  photo_url TEXT,
  photo_base64 TEXT,
  first_name VARCHAR(100) NOT NULL,
  greeting TEXT,
  cta_text TEXT,
  gif_url TEXT,
  mp4_url TEXT,
  pixar_image_url TEXT,
  video_url TEXT,
  credits_remaining INTEGER,
  duration_seconds NUMERIC,
  generation_id UUID REFERENCES generations(id) ON DELETE SET NULL,
  error TEXT,
  error_code VARCHAR(100),
  started_at TIMESTAMP WITH TIME ZONE,
  completed_at TIMESTAMP WITH TIME ZONE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

ALTER TABLE generation_jobs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can view own generation jobs" ON generation_jobs;
CREATE POLICY "Users can view own generation jobs" ON generation_jobs
  FOR SELECT USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Service can manage generation jobs" ON generation_jobs;
CREATE POLICY "Service can manage generation jobs" ON generation_jobs
  FOR ALL USING (true);

CREATE INDEX IF NOT EXISTS idx_generation_jobs_user_id ON generation_jobs(user_id);
CREATE INDEX IF NOT EXISTS idx_generation_jobs_status_created_at
  ON generation_jobs(status, created_at);

-- =============================================================
-- Error events table used for backend observability
-- =============================================================
CREATE TABLE IF NOT EXISTS error_events (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  source VARCHAR(120) NOT NULL,
  route TEXT,
  method VARCHAR(16),
  status_code INTEGER,
  user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  error_code VARCHAR(120),
  message TEXT NOT NULL,
  stack TEXT,
  context JSONB,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

ALTER TABLE error_events ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can view own error events" ON error_events;
CREATE POLICY "Users can view own error events" ON error_events
  FOR SELECT USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Service can manage error events" ON error_events;
CREATE POLICY "Service can manage error events" ON error_events
  FOR ALL USING (true);

CREATE INDEX IF NOT EXISTS idx_error_events_created_at ON error_events(created_at);
CREATE INDEX IF NOT EXISTS idx_error_events_source_created_at
  ON error_events(source, created_at);
CREATE INDEX IF NOT EXISTS idx_error_events_user_id_created_at
  ON error_events(user_id, created_at);
