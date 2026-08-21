CREATE TABLE IF NOT EXISTS business_connections (
  connection_id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  user_chat_id TEXT NOT NULL,
  is_enabled INTEGER NOT NULL DEFAULT 1,
  can_reply INTEGER NOT NULL DEFAULT 0,
  can_read_messages INTEGER NOT NULL DEFAULT 0,
  connected_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_business_connections_owner
  ON business_connections(owner_id, is_enabled);

CREATE TABLE IF NOT EXISTS chat_context_messages (
  connection_id TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  chat_id TEXT NOT NULL,
  message_id INTEGER NOT NULL,
  chat_type TEXT NOT NULL,
  chat_title TEXT NOT NULL,
  sender_id TEXT,
  sender_name TEXT NOT NULL,
  direction TEXT NOT NULL CHECK (direction IN ('incoming', 'outgoing')),
  content_type TEXT NOT NULL,
  body TEXT NOT NULL,
  sent_at TEXT NOT NULL,
  edited_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (connection_id, chat_id, message_id),
  FOREIGN KEY (connection_id) REFERENCES business_connections(connection_id)
    ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_chat_context_owner_chat_time
  ON chat_context_messages(owner_id, chat_id, sent_at DESC);

CREATE INDEX IF NOT EXISTS idx_chat_context_owner_time
  ON chat_context_messages(owner_id, sent_at DESC);
