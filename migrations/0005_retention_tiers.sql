-- Retention keys changed shape (day/week/twoweek/month -> 10min/1hour/1day/
-- 1week/1month/6month/1year), to add sub-day tiers and a clear anonymous vs
-- sign-in-required split. Normalize any existing rows to the new keys so
-- old data doesn't end up with an unrecognized retention value.
UPDATE groups SET retention = '1day'   WHERE retention = 'day';
UPDATE groups SET retention = '1week'  WHERE retention = 'week';
UPDATE groups SET retention = '1month' WHERE retention IN ('twoweek', 'month');