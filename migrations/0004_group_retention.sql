-- Retention is now chosen once per group at creation time, not per expense.
-- Existing groups default to 'month' (matches the old default expense retention).
ALTER TABLE groups ADD COLUMN retention TEXT NOT NULL DEFAULT 'month';

-- Group names double as the human-facing identity of a group, so they must
-- be unique (case-insensitive) across the whole app.
CREATE UNIQUE INDEX idx_groups_name_unique ON groups(name COLLATE NOCASE);
