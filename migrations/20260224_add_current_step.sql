-- Add current_step column to generation_jobs table.
-- Allows the backend to report fine-grained pipeline stages (e.g. 'compose')
-- so the extension can update its progress rail accurately.
ALTER TABLE generation_jobs ADD COLUMN IF NOT EXISTS current_step VARCHAR(50);
