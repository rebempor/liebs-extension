-- LinkedIn Pixar SaaS Database Schema
-- Run this in Supabase SQL Editor

-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Credits table
CREATE TABLE credits (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,
  balance INTEGER DEFAULT 0 CHECK (balance >= 0),
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  UNIQUE(user_id)
);

-- Enable Row Level Security
ALTER TABLE credits ENABLE ROW LEVEL SECURITY;

-- Policy: Users can only see their own credits
CREATE POLICY "Users can view own credits" ON credits
  FOR SELECT USING (auth.uid() = user_id);

-- Policy: Service role can manage all credits
CREATE POLICY "Service can manage credits" ON credits
  FOR ALL USING (true);

-- Transactions table (audit log)
CREATE TABLE transactions (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,
  type VARCHAR(20) NOT NULL CHECK (type IN ('purchase', 'usage', 'refund', 'bonus')),
  amount INTEGER NOT NULL,
  description TEXT,
  stripe_session_id VARCHAR(255),
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Enable Row Level Security
ALTER TABLE transactions ENABLE ROW LEVEL SECURITY;

-- Policy: Users can only see their own transactions
CREATE POLICY "Users can view own transactions" ON transactions
  FOR SELECT USING (auth.uid() = user_id);

-- Policy: Service role can insert transactions
CREATE POLICY "Service can manage transactions" ON transactions
  FOR ALL USING (true);

-- Generations table (history)
CREATE TABLE generations (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,
  linkedin_profile_url TEXT,
  gif_url TEXT,
  first_name VARCHAR(100),
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Enable Row Level Security
ALTER TABLE generations ENABLE ROW LEVEL SECURITY;

-- Policy: Users can only see their own generations
CREATE POLICY "Users can view own generations" ON generations
  FOR SELECT USING (auth.uid() = user_id);

-- Policy: Service role can insert generations
CREATE POLICY "Service can manage generations" ON generations
  FOR ALL USING (true);

-- Function to automatically create credits record on user signup
CREATE OR REPLACE FUNCTION handle_new_user()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO credits (user_id, balance)
  VALUES (NEW.id, 0);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Trigger to call function on new user
CREATE OR REPLACE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION handle_new_user();

-- Index for faster lookups
CREATE INDEX idx_credits_user_id ON credits(user_id);
CREATE INDEX idx_transactions_user_id ON transactions(user_id);
CREATE INDEX idx_generations_user_id ON generations(user_id);

-- Atomically deduct 1 credit if balance is sufficient.
-- Returns the updated row if successful, empty result if insufficient balance.
CREATE OR REPLACE FUNCTION deduct_credit(p_user_id UUID)
RETURNS SETOF credits AS $$
  UPDATE credits
  SET balance = balance - 1, updated_at = NOW()
  WHERE user_id = p_user_id AND balance >= 1
  RETURNING *;
$$ LANGUAGE sql SECURITY DEFINER;

-- Refund 1 credit (used when generation fails after deduction).
CREATE OR REPLACE FUNCTION refund_credit(p_user_id UUID)
RETURNS VOID AS $$
  UPDATE credits
  SET balance = balance + 1, updated_at = NOW()
  WHERE user_id = p_user_id;
$$ LANGUAGE sql SECURITY DEFINER;

-- =============================================================
-- Async generation jobs (queue + polling)
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
-- Error tracking events (backend observability)
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
