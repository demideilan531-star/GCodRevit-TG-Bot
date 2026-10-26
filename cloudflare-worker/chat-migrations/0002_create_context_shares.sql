CREATE TABLE IF NOT EXISTS context_shares (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  chat_id TEXT NOT NULL,
  message_limit INTEGER NOT NULL CHECK (message_limit BETWEEN 1 AND 200),
  ttl_hours INTEGER NOT NULL CHECK (ttl_hours IN (1, 24, 168)),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_context_shares_owner_chat
  ON context_shares(owner_id, chat_id, expires_at);
