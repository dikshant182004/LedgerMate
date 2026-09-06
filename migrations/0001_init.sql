-- Ledger: groups are the shareable unit. A group's id doubles as its access
-- token (long, random, unguessable) since there is no login system.

CREATE TABLE groups (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  currency   TEXT NOT NULL DEFAULT '$',
  created_at INTEGER NOT NULL
);

CREATE TABLE members (
  id         TEXT PRIMARY KEY,
  group_id   TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE expenses (
  id          TEXT PRIMARY KEY,
  group_id    TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  description TEXT NOT NULL,
  amount      REAL NOT NULL,
  paid_by     TEXT NOT NULL REFERENCES members(id),
  created_at  INTEGER NOT NULL
);

CREATE TABLE expense_splits (
  id           TEXT PRIMARY KEY,
  expense_id   TEXT NOT NULL REFERENCES expenses(id) ON DELETE CASCADE,
  member_id    TEXT NOT NULL REFERENCES members(id),
  share_amount REAL NOT NULL
);

CREATE INDEX idx_members_group  ON members(group_id);
CREATE INDEX idx_expenses_group ON expenses(group_id);
CREATE INDEX idx_splits_expense ON expense_splits(expense_id);
CREATE INDEX idx_splits_member  ON expense_splits(member_id);
