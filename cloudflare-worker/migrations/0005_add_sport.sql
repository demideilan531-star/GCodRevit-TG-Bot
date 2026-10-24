CREATE TABLE IF NOT EXISTS sport_profiles (
  owner_id TEXT PRIMARY KEY,
  timezone TEXT NOT NULL DEFAULT 'Europe/Moscow',
  goals_json TEXT NOT NULL DEFAULT '{}',
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sport_days (
  owner_id TEXT NOT NULL,
  date TEXT NOT NULL,
  weight_kg REAL CHECK (weight_kg IS NULL OR weight_kg BETWEEN 20 AND 400),
  sleep_hours REAL CHECK (sleep_hours IS NULL OR sleep_hours BETWEEN 0 AND 24),
  sleep_quality INTEGER CHECK (sleep_quality IS NULL OR sleep_quality BETWEEN 1 AND 5),
  water_ml INTEGER CHECK (water_ml IS NULL OR water_ml BETWEEN 0 AND 20000),
  steps INTEGER CHECK (steps IS NULL OR steps BETWEEN 0 AND 150000),
  training TEXT CHECK (training IS NULL OR training IN ('rest','strength','cardio','stretch','other')),
  mood INTEGER CHECK (mood IS NULL OR mood BETWEEN 1 AND 5),
  nutrition INTEGER CHECK (nutrition IS NULL OR nutrition IN (0,1)),
  comment TEXT NOT NULL DEFAULT '',
  coach_note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (owner_id, date)
);

CREATE TABLE IF NOT EXISTS sport_meals (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  date TEXT NOT NULL,
  time TEXT NOT NULL,
  title TEXT NOT NULL,
  calories_kcal REAL CHECK (calories_kcal IS NULL OR calories_kcal BETWEEN 0 AND 10000),
  protein_g REAL CHECK (protein_g IS NULL OR protein_g BETWEEN 0 AND 1000),
  fat_g REAL CHECK (fat_g IS NULL OR fat_g BETWEEN 0 AND 1000),
  carbs_g REAL CHECK (carbs_g IS NULL OR carbs_g BETWEEN 0 AND 2000),
  note TEXT NOT NULL DEFAULT '',
  source_type TEXT NOT NULL DEFAULT 'mini_app' CHECK (source_type IN ('mini_app','telegram')),
  nutrition_source TEXT NOT NULL DEFAULT 'manual' CHECK (nutrition_source IN ('manual','estimated')),
  media_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sport_meals_owner_date ON sport_meals (owner_id, date, time);

CREATE TABLE IF NOT EXISTS sport_reminders (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('sleep','meal','evening','water','steps')),
  time TEXT NOT NULL,
  label TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0,1)),
  next_due_at TEXT,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sport_reminders_due ON sport_reminders (enabled, next_due_at);

CREATE TABLE IF NOT EXISTS sport_prompts (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  chat_id TEXT NOT NULL,
  message_id INTEGER,
  kind TEXT NOT NULL CHECK (kind IN ('sleep','meal','evening','water','steps')),
  label TEXT NOT NULL,
  date TEXT NOT NULL,
  time TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','processing','completed','failed')),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sport_prompt_reply ON sport_prompts (owner_id, chat_id, message_id);

CREATE TABLE IF NOT EXISTS sport_prompt_messages (
  owner_id TEXT NOT NULL,
  chat_id TEXT NOT NULL,
  message_id INTEGER NOT NULL,
  prompt_id TEXT NOT NULL REFERENCES sport_prompts(id) ON DELETE CASCADE,
  PRIMARY KEY (owner_id, chat_id, message_id)
);

-- One claim per scheduled occurrence prevents duplicate messages when cron retries.
CREATE TABLE IF NOT EXISTS sport_deliveries (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'claimed',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sport_deliveries_created ON sport_deliveries (created_at);

-- Telegram update IDs are routing metadata only; message/photo content is not retained.
CREATE TABLE IF NOT EXISTS sport_updates (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sport_updates_created ON sport_updates (created_at);
CREATE INDEX IF NOT EXISTS idx_sport_prompts_expires ON sport_prompts (expires_at);
