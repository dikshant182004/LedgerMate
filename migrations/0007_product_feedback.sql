-- Migration: Global Product Feedback & Issue Reporting
CREATE TABLE IF NOT EXISTS product_feedback (
  id          TEXT PRIMARY KEY,
  user_id     TEXT REFERENCES users(id),
  category    TEXT NOT NULL,
  rating      INTEGER,
  feedback    TEXT NOT NULL,
  context_url TEXT,
  email       TEXT,
  created_at  INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_feedback_created ON product_feedback(created_at DESC);
