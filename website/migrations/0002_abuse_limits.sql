-- 0002_abuse_limits.sql — confirmation-email quota accounting (D-427).
--
-- `email_sends` has one row per confirmation email handed to Resend, so the
-- daily and monthly caps are counted from our own sends only (broadcasts are
-- billed on the marketing plan and never appear here). It holds a timestamp and
-- nothing else: no address, no visitor data.
CREATE TABLE email_sends (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  -- Unix milliseconds, written by the application.
  sent_at INTEGER NOT NULL
);
CREATE INDEX email_sends_sent_at ON email_sends (sent_at);

-- 1 while a pending address is stored but its confirmation email was held back
-- because a cap was reached; the drain Worker sends those oldest first and
-- resets it to 0.
ALTER TABLE waitlist ADD COLUMN email_held INTEGER NOT NULL DEFAULT 0 CHECK (email_held IN (0, 1));
CREATE INDEX waitlist_held ON waitlist (created_at) WHERE email_held = 1;
