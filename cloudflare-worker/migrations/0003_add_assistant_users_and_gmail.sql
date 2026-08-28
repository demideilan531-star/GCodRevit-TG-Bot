CREATE TABLE IF NOT EXISTS assistant_users (
  id TEXT PRIMARY KEY,
  telegram_user_id TEXT UNIQUE,
  username TEXT COLLATE NOCASE UNIQUE,
  role TEXT NOT NULL DEFAULT 'user'
    CHECK (role IN ('admin', 'user')),
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'active', 'blocked')),
  can_tasks INTEGER NOT NULL DEFAULT 1,
  can_weather INTEGER NOT NULL DEFAULT 1,
  can_gmail INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_seen_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_assistant_users_status
  ON assistant_users (status, username);

CREATE TABLE IF NOT EXISTS assistant_sessions (
  owner_id TEXT PRIMARY KEY,
  mode TEXT NOT NULL
    CHECK (mode IN ('gmail_email', 'gmail_password')),
  data_json TEXT NOT NULL DEFAULT '{}',
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS gmail_accounts (
  owner_id TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  password_ciphertext TEXT NOT NULL,
  password_iv TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'verifying'
    CHECK (status IN ('verifying', 'active', 'error')),
  state_json TEXT NOT NULL DEFAULT '{"uids":[],"uidvalidity":null}',
  last_checked_at TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS gmail_requests (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  chat_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('validate', 'report')),
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'claimed', 'completed', 'failed')),
  period_start TEXT,
  checkpoint_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  claimed_at TEXT,
  completed_at TEXT,
  expires_at TEXT NOT NULL,
  error TEXT
);

CREATE INDEX IF NOT EXISTS idx_gmail_requests_owner_status
  ON gmail_requests (owner_id, status, created_at);

INSERT OR IGNORE INTO assistant_users (
  id, telegram_user_id, username, role, status,
  can_tasks, can_weather, can_gmail, created_at, updated_at
) VALUES
  ('seed-killtist', NULL, 'killtist', 'user', 'pending', 1, 1, 1,
   strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('seed-animixon', NULL, 'animixon', 'user', 'pending', 1, 1, 1,
   strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
