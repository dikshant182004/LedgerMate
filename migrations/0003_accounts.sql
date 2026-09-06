-- Accounts (Google sign-in). Login is optional — anonymous group links still work.
CREATE TABLE users (
  id          TEXT PRIMARY KEY,
  google_sub  TEXT UNIQUE NOT NULL,
  email       TEXT NOT NULL,
  name        TEXT NOT NULL,
  picture     TEXT,
  created_at  INTEGER NOT NULL
);

CREATE TABLE sessions (
  id          TEXT PRIMARY KEY,   -- random token, stored as an httpOnly cookie
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at  INTEGER NOT NULL,
  created_at  INTEGER NOT NULL
);
CREATE INDEX idx_sessions_user ON sessions(user_id);

-- Track who made what, so "My Groups" and reminder emails are possible.
ALTER TABLE groups   ADD COLUMN created_by TEXT REFERENCES users(id);
ALTER TABLE expenses ADD COLUMN created_by TEXT REFERENCES users(id);

-- Prevents sending the same reminder email more than once.
ALTER TABLE expenses ADD COLUMN reminded_at INTEGER;

CREATE INDEX idx_groups_created_by   ON groups(created_by);
CREATE INDEX idx_expenses_created_by ON expenses(created_by);
