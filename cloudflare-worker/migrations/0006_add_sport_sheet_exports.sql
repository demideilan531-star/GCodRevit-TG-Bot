CREATE TABLE IF NOT EXISTS sport_sheet_exports (
  owner_id TEXT PRIMARY KEY,
  spreadsheet_id TEXT NOT NULL UNIQUE,
  enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0,1)),
  verification_code TEXT NOT NULL,
  verified_at TEXT,
  last_sync_at TEXT,
  last_sync_date TEXT,
  last_attempt_at TEXT,
  error_code TEXT,
  lease_until TEXT,
  lease_token TEXT,
  updated_at TEXT NOT NULL
);
