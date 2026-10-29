# waitlist-drain

A Cloudflare Worker with an hourly Cron Trigger that sends the waitlist's held
confirmation emails (D-427). The signup Pages Function holds an email when the
daily (`CONFIRM_EMAILS_PER_DAY`) or monthly (`CONFIRM_EMAILS_PER_MONTH`) cap is
reached; this sends them later, oldest first, within the remaining budget, at
most 20 per run.

Boundary: it only runs `drainHeld` from `../../functions/_lib/quota.ts`. It
serves no requests and holds no logic of its own. Deploy and secret commands are
at the top of `wrangler.toml` and in `../../BETA_SIGNUP_SETUP.md`.
