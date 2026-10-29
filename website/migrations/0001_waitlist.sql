-- 0001_waitlist.sql — the beta waitlist (D-426).
--
-- One row per person. No IP address, user agent or any other request metadata
-- is stored (the privacy page lists exactly these columns). Timestamps are
-- unix milliseconds, written by the application.
CREATE TABLE waitlist (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  -- Lowercased and trimmed by the application before it is stored.
  email             TEXT    NOT NULL UNIQUE,
  -- One of ROLES in src/data/beta.ts, or NULL when skipped.
  role              TEXT,
  -- Which form the visitor used ("hero" or "beta"), or NULL.
  source            TEXT,
  status            TEXT    NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending', 'confirmed', 'unsubscribed')),
  confirm_token     TEXT    NOT NULL UNIQUE,
  unsubscribe_token TEXT    NOT NULL UNIQUE,
  created_at        INTEGER NOT NULL,
  -- When the confirmation email was last handed to the mail provider; drives
  -- the resend throttle.
  last_email_at     INTEGER,
  confirmed_at      INTEGER,
  unsubscribed_at   INTEGER,
  -- 1 when Resend's contact list matches this row (confirmed: subscribed and in
  -- the segment; unsubscribed: marked unsubscribed). Reset to 0 on every status
  -- change and set to 1 only after Resend accepts it; `scripts/sync-resend.ts
  -- backfill` retries the 0 rows.
  resend_synced     INTEGER NOT NULL DEFAULT 0 CHECK (resend_synced IN (0, 1))
);

CREATE INDEX waitlist_status ON waitlist (status);
