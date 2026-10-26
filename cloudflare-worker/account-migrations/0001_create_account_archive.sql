CREATE TABLE IF NOT EXISTS account_context_sync (
  owner_id TEXT PRIMARY KEY,
  enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
  owner_confirmed_at TEXT,
  generation INTEGER NOT NULL DEFAULT 1,
  lease_id TEXT,
  lease_run TEXT,
  lease_until TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  dialogs_complete INTEGER NOT NULL DEFAULT 0 CHECK (dialogs_complete IN (0, 1)),
  dialog_cursor_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(dialog_cursor_json) AND length(dialog_cursor_json) <= 16384),
  update_state_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(update_state_json) AND length(update_state_json) <= 16384),
  quota_day TEXT NOT NULL,
  quota_used INTEGER NOT NULL DEFAULT 0,
  last_sync_at TEXT,
  last_error TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS account_context_chats (
  owner_id TEXT NOT NULL,
  chat_id TEXT NOT NULL,
  chat_type TEXT NOT NULL CHECK (chat_type IN ('private', 'bot', 'group', 'supergroup', 'channel', 'saved')),
  chat_title TEXT NOT NULL,
  archived INTEGER NOT NULL DEFAULT 0 CHECK (archived IN (0, 1)),
  top_message_id INTEGER NOT NULL DEFAULT 0,
  last_message_at TEXT,
  stored_count INTEGER NOT NULL DEFAULT 0,
  latest_synced_id INTEGER NOT NULL DEFAULT 0,
  history_before_id INTEGER,
  history_complete INTEGER NOT NULL DEFAULT 0 CHECK (history_complete IN (0, 1)),
  history_status TEXT NOT NULL DEFAULT 'pending' CHECK (history_status IN ('pending', 'loading', 'complete', 'unavailable', 'paused')),
  channel_pts INTEGER,
  deleted_before_id INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (owner_id, chat_id)
);
CREATE INDEX IF NOT EXISTS idx_account_context_chats_time
  ON account_context_chats(owner_id, last_message_at DESC, chat_id);

CREATE TABLE IF NOT EXISTS account_context_messages (
  owner_id TEXT NOT NULL,
  chat_id TEXT NOT NULL,
  message_id INTEGER NOT NULL,
  sender_name TEXT NOT NULL,
  direction TEXT NOT NULL CHECK (direction IN ('incoming', 'outgoing')),
  content_type TEXT NOT NULL,
  body TEXT NOT NULL,
  sent_at TEXT NOT NULL,
  edited_at TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (owner_id, chat_id, message_id),
  FOREIGN KEY (owner_id, chat_id) REFERENCES account_context_chats(owner_id, chat_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_account_context_messages_time
  ON account_context_messages(owner_id, chat_id, sent_at DESC, message_id DESC);

CREATE TABLE IF NOT EXISTS account_context_deleted_messages (
  owner_id TEXT NOT NULL,
  chat_id TEXT NOT NULL,
  message_id INTEGER NOT NULL,
  deleted_at TEXT NOT NULL,
  PRIMARY KEY (owner_id, chat_id, message_id)
);

CREATE TABLE IF NOT EXISTS account_context_batches (
  owner_id TEXT NOT NULL,
  batch_id TEXT NOT NULL,
  lease_id TEXT NOT NULL,
  generation INTEGER NOT NULL,
  body_hash TEXT NOT NULL,
  applied INTEGER NOT NULL DEFAULT 0 CHECK (applied IN (0, 1)),
  quota_cost INTEGER NOT NULL,
  actual_rows_written INTEGER,
  created_at TEXT NOT NULL,
  PRIMARY KEY (owner_id, batch_id)
);
