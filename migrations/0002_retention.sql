-- Adds expiry to expenses so free-tier storage stays bounded.
-- expires_at = NULL means "kept permanently" (capped at 2 per group in app logic).
ALTER TABLE expenses ADD COLUMN expires_at INTEGER;

CREATE INDEX idx_expenses_expires ON expenses(expires_at);
