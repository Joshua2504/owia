ALTER TABLE intake_photos
  ADD COLUMN IF NOT EXISTS processing_status VARCHAR(20) NOT NULL DEFAULT 'ready',
  ADD COLUMN IF NOT EXISTS processing_error TEXT NULL;
CREATE INDEX IF NOT EXISTS idx_intake_photos_processing ON intake_photos(batch_id, processing_status);
