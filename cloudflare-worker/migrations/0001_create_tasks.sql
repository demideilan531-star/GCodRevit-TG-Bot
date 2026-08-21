CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  due_at TEXT,
  timezone TEXT NOT NULL DEFAULT 'Europe/Moscow',
  status TEXT NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'todo', 'in_progress', 'done', 'archived')),
  flags_json TEXT NOT NULL DEFAULT '[]',
  source_type TEXT NOT NULL DEFAULT 'mini_app'
    CHECK (source_type IN ('text', 'voice', 'mini_app')),
  source_text TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_tasks_owner_status_due
  ON tasks (owner_id, status, due_at);

CREATE TABLE IF NOT EXISTS task_sessions (
  owner_id TEXT PRIMARY KEY,
  mode TEXT NOT NULL CHECK (mode IN ('capture')),
  updated_at TEXT NOT NULL
);
