-- Add mp4_no_text_url column to generations table.
-- Stores the S3 URL of the pre-rendered MP4 before text was applied via ffmpeg drawtext.
-- This allows re-stamping text cheaply without re-running the full Remotion pipeline.
ALTER TABLE generations ADD COLUMN IF NOT EXISTS mp4_no_text_url TEXT;
