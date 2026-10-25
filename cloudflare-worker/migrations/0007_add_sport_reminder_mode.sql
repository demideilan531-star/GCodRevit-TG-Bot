ALTER TABLE sport_reminders ADD COLUMN mode TEXT NOT NULL DEFAULT 'notification'
  CHECK (mode IN ('notification', 'question'));
