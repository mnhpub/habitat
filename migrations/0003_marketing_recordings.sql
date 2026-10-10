-- Email campaigns and session recordings. Recipients are stored per campaign so sends can resume after failures.

CREATE TABLE IF NOT EXISTS campaigns (
  id          TEXT PRIMARY KEY,
  org_id      TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL CHECK (kind IN ('campaign', 'notice')),
  subject     TEXT NOT NULL,
  body        TEXT NOT NULL,
  audience    TEXT NOT NULL,               -- JSON: {"kind":"subscribers"} | {"kind":"event","eventId"} | {"kind":"series","seriesId"} | {"kind":"notice","seriesId"}
  status      TEXT NOT NULL CHECK (status IN ('draft', 'sending', 'sent')),
  total       INTEGER NOT NULL DEFAULT 0,
  sent        INTEGER NOT NULL DEFAULT 0,
  failed      INTEGER NOT NULL DEFAULT 0,
  created_by  TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  sent_at     INTEGER
);
CREATE INDEX IF NOT EXISTS campaigns_by_org ON campaigns(org_id, created_at);
CREATE INDEX IF NOT EXISTS campaigns_by_status ON campaigns(status);

CREATE TABLE IF NOT EXISTS campaign_recipients (
  campaign_id TEXT NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  email       TEXT NOT NULL,
  status      TEXT NOT NULL CHECK (status IN ('pending', 'sent', 'failed', 'suppressed')),
  attempts    INTEGER NOT NULL DEFAULT 0,
  error       TEXT,
  PRIMARY KEY (campaign_id, email)
);
CREATE INDEX IF NOT EXISTS recipients_pending ON campaign_recipients(campaign_id, status);

-- People who unsubscribed from a workspace's email. Checked at send time, for every campaign.
CREATE TABLE IF NOT EXISTS email_optouts (
  email       TEXT NOT NULL,
  org_id      TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  at          INTEGER NOT NULL,
  PRIMARY KEY (email, org_id)
);

CREATE TABLE IF NOT EXISTS recordings (
  id           TEXT PRIMARY KEY,
  event_id     TEXT NOT NULL,
  org_id       TEXT NOT NULL,
  title        TEXT NOT NULL,
  session_key  TEXT NOT NULL,
  started_by   TEXT NOT NULL,
  started_at   INTEGER NOT NULL,
  ended_at     INTEGER,
  status       TEXT NOT NULL CHECK (status IN ('recording', 'ready')),
  parts        INTEGER NOT NULL DEFAULT 0,
  bytes        INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS recordings_by_event ON recordings(event_id, started_at);
CREATE INDEX IF NOT EXISTS recordings_by_org ON recordings(org_id, started_at);

-- Each part is one object in R2; parts are appended in order and concatenated on download.
CREATE TABLE IF NOT EXISTS recording_parts (
  recording_id TEXT NOT NULL REFERENCES recordings(id) ON DELETE CASCADE,
  part         INTEGER NOT NULL,
  bytes        INTEGER NOT NULL,
  PRIMARY KEY (recording_id, part)
);
