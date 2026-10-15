CREATE TABLE IF NOT EXISTS briefing_requests (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  chat_id TEXT NOT NULL,
  message_id INTEGER,
  status TEXT NOT NULL CHECK (status IN ('pending', 'claimed', 'completed', 'failed')),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  completed_at TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS briefing_one_active_per_owner
  ON briefing_requests(owner_id) WHERE status IN ('pending', 'claimed');
