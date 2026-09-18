-- Migration: Calculation Agent History and Human-in-the-Loop Feedback
CREATE TABLE IF NOT EXISTS calc_history (
  id              TEXT PRIMARY KEY,
  user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  query           TEXT NOT NULL,
  category        TEXT NOT NULL,
  headline_result TEXT NOT NULL,
  data_json       TEXT NOT NULL,
  latency_ms      INTEGER NOT NULL,
  created_at      INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_calc_history_user ON calc_history(user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS calc_feedback (
  id              TEXT PRIMARY KEY,
  calc_id         TEXT NOT NULL REFERENCES calc_history(id) ON DELETE CASCADE,
  user_id         TEXT NOT NULL REFERENCES users(id),
  rating          TEXT NOT NULL,
  hitl_note       TEXT,
  status          TEXT NOT NULL DEFAULT 'submitted',
  created_at      INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_calc_feedback_calc ON calc_feedback(calc_id);
