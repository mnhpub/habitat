-- Events, who works on them, and the people who have signed in.
-- Live event state lives in each event's Durable Object, not here.

CREATE TABLE IF NOT EXISTS events (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  kind        TEXT NOT NULL DEFAULT 'corporate',
  venue       TEXT NOT NULL DEFAULT '',
  created_by  TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  -- 1: anyone signed in through Access may join as an attendee.
  join_open   INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS members (
  event_id    TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  email       TEXT NOT NULL,
  name        TEXT NOT NULL DEFAULT '',
  roles       TEXT NOT NULL,           -- JSON array of roles
  added_by    TEXT NOT NULL,
  added_at    INTEGER NOT NULL,
  PRIMARY KEY (event_id, email)
);
CREATE INDEX IF NOT EXISTS members_by_email ON members(email);

CREATE TABLE IF NOT EXISTS users (
  email       TEXT PRIMARY KEY,
  name        TEXT NOT NULL DEFAULT '',
  last_seen   INTEGER NOT NULL,
  warp        INTEGER NOT NULL DEFAULT 0
);
