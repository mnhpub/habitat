-- Workspaces (tenants), their members, recurring series and event subscriptions.
-- Existing events are moved into a workspace named after their creator, so nothing is orphaned.

CREATE TABLE IF NOT EXISTS organizations (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  created_by  TEXT NOT NULL,
  created_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS org_members (
  org_id      TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  email       TEXT NOT NULL,
  role        TEXT NOT NULL CHECK (role IN ('owner', 'admin', 'member')),
  added_by    TEXT NOT NULL,
  added_at    INTEGER NOT NULL,
  PRIMARY KEY (org_id, email)
);
CREATE INDEX IF NOT EXISTS org_members_by_email ON org_members(email);

ALTER TABLE events ADD COLUMN org_id TEXT REFERENCES organizations(id);
ALTER TABLE events ADD COLUMN starts_at INTEGER;
ALTER TABLE events ADD COLUMN duration_min INTEGER NOT NULL DEFAULT 60;
ALTER TABLE events ADD COLUMN series_id TEXT;
CREATE INDEX IF NOT EXISTS events_by_org ON events(org_id, starts_at);
-- A series produces at most one event per start time, even if two schedulers race.
CREATE UNIQUE INDEX IF NOT EXISTS events_series_occurrence ON events(series_id, starts_at) WHERE series_id IS NOT NULL;

INSERT OR IGNORE INTO organizations (id, name, created_by, created_at)
  SELECT 'ws-' || lower(hex(created_by)), created_by, created_by, MIN(created_at) FROM events GROUP BY created_by;
INSERT OR IGNORE INTO org_members (org_id, email, role, added_by, added_at)
  SELECT 'ws-' || lower(hex(created_by)), created_by, 'owner', created_by, MIN(created_at) FROM events GROUP BY created_by;
UPDATE events SET org_id = 'ws-' || lower(hex(created_by)) WHERE org_id IS NULL;

CREATE TABLE IF NOT EXISTS series (
  id              TEXT PRIMARY KEY,
  org_id          TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name            TEXT NOT NULL,
  kind            TEXT NOT NULL DEFAULT 'corporate',
  venue           TEXT NOT NULL DEFAULT '',
  duration_min    INTEGER NOT NULL,
  timezone        TEXT NOT NULL,
  time_of_day     TEXT NOT NULL,            -- HH:MM, wall clock in timezone
  freq            TEXT NOT NULL CHECK (freq IN ('weekly', 'monthly')),
  interval_n      INTEGER NOT NULL DEFAULT 1,
  by_day          TEXT NOT NULL DEFAULT '[]', -- JSON array of weekdays, 0 = Sunday
  day_of_month    INTEGER,
  starts_on       TEXT NOT NULL,            -- YYYY-MM-DD in timezone
  ends_on         TEXT,
  max_occurrences INTEGER NOT NULL DEFAULT 52,
  join_open       INTEGER NOT NULL DEFAULT 1,
  anchor_event_id TEXT,                     -- team for later occurrences is copied from this one
  active          INTEGER NOT NULL DEFAULT 1,
  created_by      TEXT NOT NULL,
  created_at      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS series_by_org ON series(org_id);

-- Following a workspace or a series. Only public (join-open) events are ever shared through a subscription.
CREATE TABLE IF NOT EXISTS subscriptions (
  email        TEXT NOT NULL,
  target_kind  TEXT NOT NULL CHECK (target_kind IN ('org', 'series')),
  target_id    TEXT NOT NULL,
  token        TEXT NOT NULL UNIQUE,
  created_at   INTEGER NOT NULL,
  PRIMARY KEY (email, target_kind, target_id)
);
CREATE INDEX IF NOT EXISTS subscriptions_by_target ON subscriptions(target_kind, target_id);
