# Beta waitlist — how it works, and how to run it

The signup forms (hero and the Beta section) post to the site's own waitlist
(D-426): a Cloudflare Pages Function, a D1 database and Resend. It replaced
FormSubmit.co, which was never a list. **D1 is the master list**; Resend holds a
copy of confirmed addresses only so broadcasts can be sent from its dashboard.

## How it works

```
form ──POST /api/waitlist──▶ size cap, honeypot, email rule, disposable-domain blocklist
                             Cloudflare Turnstile siteverify (fails closed)
                             INSERT OR IGNORE into D1 (status = pending)
                             daily / monthly cap? over it: flag email_held, send nothing
                             Resend "send email": plain confirmation (no List-Unsubscribe)
Cron (hourly) ──▶ workers/waitlist-drain: send the held confirmations, oldest first, within the budget
inbox ──GET /api/confirm?token=──▶ status = confirmed ──▶ Resend contact + segment ──▶ /waitlist/confirmed/
inbox ──GET|POST /api/unsubscribe?token=──▶ status = unsubscribed ──▶ Resend contact unsubscribed ──▶ /waitlist/unsubscribed/
```

| file | role |
|---|---|
| `functions/api/{waitlist,confirm,unsubscribe}.ts` | the three routes, one-line adapters |
| `functions/_lib/waitlist.ts` | the signup / confirm / unsubscribe logic (tested over real SQLite, `tests/waitlist.test.ts`) |
| `functions/_lib/turnstile.ts` | Turnstile siteverify (token, secret, hostname) |
| `functions/_lib/quota.ts` | the daily / monthly confirmation budget and the drain of held emails |
| `functions/_lib/send.ts` | the one Resend "send email" call |
| `workers/waitlist-drain/` | the hourly Cron Worker that runs the drain (deployed separately) |
| `src/data/disposable-domains.ts` | the disposable-address blocklist |
| `src/components/TurnstileWidget.astro` | the widget inside each form |
| `functions/_lib/resend-contacts.ts` | the Resend Contacts API calls |
| `functions/_lib/email.ts` | the confirmation email (HTML + text) |
| `migrations/0001_waitlist.sql`, `0002_abuse_limits.sql` | the table; the send counter and the `email_held` flag |
| `src/data/beta.ts` | endpoint, email rule and roles, shared by the forms and the function |
| `src/pages/waitlist/*.astro` | confirmed / unsubscribed / invalid-link pages (noindex, not in the sitemap) |
| `scripts/export-waitlist.mjs`, `scripts/sync-resend.ts` | CSV export; Resend reconcile + backfill |
| `wrangler.toml` | Pages config: `DB` binding, `MAIL_FROM`, `MAIL_REPLY_TO`, `RESEND_THROTTLE_MINUTES`, `RESEND_SEGMENT_ID`, the two caps, `TURNSTILE_ALLOWED_HOSTNAMES` |

Behaviours worth knowing:

- A signup always answers `{ ok: true }` for a valid address, whether it is new,
  pending, confirmed or returning, so the form cannot be used to find out who is
  on the list. The confirmation email is re-sent to a pending address at most
  once per `RESEND_THROTTLE_MINUTES` (10). Signing up again after unsubscribing
  is treated as consent again: back to pending with a fresh confirm link.
- Abuse limits that store nothing about the visitor (D-427): 4 KiB body cap, a
  hidden honeypot field (`company`), the email rule, the disposable-domain
  blocklist (rejected with the ordinary invalid-address answer), Cloudflare
  Turnstile, the per-address throttle, and the daily and monthly caps below. No
  IP is stored or logged, which is what `/privacy/` promises. The WAF rate-limit
  rule further down is the last, outermost layer.
- **Turnstile fails closed.** The form posts the widget's token as
  `cf-turnstile-response`; the function verifies it with `TURNSTILE_SECRET_KEY`
  and the token's hostname against `TURNSTILE_ALLOWED_HOSTNAMES`. A bad or
  missing token answers 403; a missing secret or an unreachable Cloudflare
  answers 503 and logs `TURNSTILE_SECRET_KEY is not set` / `siteverify`, and no
  row is stored. Never deploy without the secret, or nobody can sign up.
- **Confirmation-email caps.** `CONFIRM_EMAILS_PER_DAY` (90) and
  `CONFIRM_EMAILS_PER_MONTH` (2900) sit under Resend's free 100/day and
  3,000/month. They are counted from our own sends only (the `email_sends`
  table, UTC day and month); whichever is reached first holds the email. Over a
  cap the signup is still stored as pending (`email_held = 1`) and the visitor
  sees the normal success; the email goes out later (next section). Broadcasts
  are billed on Resend's marketing plan, a separate allowance that these
  counters do not touch; the monthly 2,900 also leaves headroom for any
  non-waitlist send (tests, one-off mail) on the same Resend account.
- A Resend failure at confirm or unsubscribe never fails the visitor: it is
  logged and the row keeps `resend_synced = 0` for the backfill (below). A
  failure to send the confirmation email itself (Resend non-2xx or a network
  error) is hidden too: the row is flagged `email_held = 1`, the visitor sees the
  normal success, and the hourly drain retries it. Only successful sends are
  counted against the caps.
- **Confirmation email.** Subject "Confirm your email for the Apelles beta", a
  near-plain first-person note from Ashish with a plain link and no unsubscribe
  link or `List-Unsubscribe` headers (Gmail files bulk-styled mail under
  Promotions; D-427 addendum). The link works for 7 days from the last
  confirmation email sent (`CONFIRM_TTL_MS`); after that signing up again sends
  a fresh one. Unconfirmed addresses are never emailed again: only signup and
  the drain send, and broadcasts go to the confirmed Resend segment.
- Email security scanners sometimes open links in a message, which can confirm
  an address on the visitor's behalf. Acceptable for a beta list; the
  unsubscribe link has the same property.
- With no `RESEND_API_KEY` (local dev) the row is stored and the sending is
  skipped, with a warning in the log; nothing is counted against the caps.
- **Sender addresses.** Confirmations send from `Ashish from Apelles <hello@mail.apelles.studio>`
  with `Reply-To: hello@apelles.studio` (`MAIL_FROM`, `MAIL_REPLY_TO`).
  Broadcasts send from `news.apelles.studio`, a separate subdomain, so
  marketing complaints cannot hurt signup confirmations. The root domain
  `apelles.studio` sends nothing. Both subdomains must be verified in Resend
  (sending only, tracking off).

## One-time setup (the coordinator / owner does the remote steps)

### 1. Cloudflare Turnstile (owner, in the dashboard)

1. Cloudflare dashboard > **Turnstile** > **Add widget**.
2. Widget name `Apelles waitlist`. **Hostnames:** add `apelles.studio` and
   `www.apelles.studio`.
3. **Widget mode: Managed.** (The forms render it with `interaction-only`, so
   most people never see it.) Leave pre-clearance off. Create.
4. Copy the **Site Key** (public) and the **Secret Key** (private; do not paste
   it anywhere but the command below).

```bash
cd website && npm ci

# The secret, as a Pages secret (it prompts for the value; never in the repo).
npx wrangler pages secret put TURNSTILE_SECRET_KEY --project-name=apelles-studio

# The site key, as a repo VARIABLE (public, read at build time by the deploy workflow).
gh variable set PUBLIC_TURNSTILE_SITE_KEY --body '<the Site Key>'
```

Then redeploy the site (push to `main`, or run the "Deploy website" workflow).
A build without the variable uses Cloudflare's test key and warns; signups then
fail in production, which is the safe failure.

### 2. The database, the Resend key, the deploy

```bash
# The schema, on the REMOTE database (0002 adds the send counter and email_held).
npx wrangler d1 migrations apply apelles-waitlist --remote

# The Resend API key, as a Pages secret (it is never in the repo).
npx wrangler pages secret put RESEND_API_KEY --project-name=apelles-studio

# Deploy (CI does this on a push to main touching website/).
```

In Resend, verify the sending subdomain `mail.apelles.studio` (its DNS records
go on that subdomain only) and `news.apelles.studio` for broadcasts. The sender
is `Ashish from Apelles <hello@mail.apelles.studio>` (`MAIL_FROM`), replies go to
`hello@apelles.studio` (`MAIL_REPLY_TO`). The segment `Apelles Beta` is
`RESEND_SEGMENT_ID`.

### 3. The drain Worker (sends held confirmations automatically)

Pages Functions have no cron, so a tiny separate Worker with an hourly Cron
Trigger does it (`workers/waitlist-drain/`, D-427). Not deployed by CI.

```bash
cd website
npx wrangler deploy --config workers/waitlist-drain/wrangler.toml
npx wrangler secret put RESEND_API_KEY --config workers/waitlist-drain/wrangler.toml
```

It sends at most 20 held confirmations per run, oldest first, and never past
the day or month budget. Its `[vars]` repeat the Pages project's mail settings
and caps; change both files together. To try it by hand without waiting for the
hour: `npx wrangler dev --config workers/waitlist-drain/wrangler.toml --test-scheduled`
then `curl "http://localhost:8787/__scheduled"` (add `--remote` only on purpose:
it would use the real database).

### 4. The WAF rate-limiting rule (owner, in the dashboard)

The outermost layer, before the Function even runs (it saves the Pages
Functions free 100,000 requests a day). Cloudflare dashboard > the
`apelles.studio` zone > **Security** > **Security rules** > **Create rule** >
**Rate limiting rules**. The Free plan allows one such rule, counted per IP
only, with a 10-second period and 10-second block (checked against
Cloudflare's docs, 2026-10-29):

| Setting | Value |
|---|---|
| Rule name | `Waitlist signup rate limit` |
| When incoming requests match | Edit expression: `(http.request.uri.path eq "/api/waitlist" and http.request.method eq "POST")` |
| With the same characteristics | IP (preset on Free) |
| When rate exceeds | **5** requests per **10 seconds** |
| Then take action | **Block** (Free plan; on Pro and up use *Managed Challenge*) |
| For duration | **10 seconds** (the only Free option) |

Five signups in ten seconds from one address is far above any person (the form
is disabled while a request is in flight). This is a speed bump, not the
defence: a script that waits ten seconds between posts passes it, and Turnstile,
the blocklist and the email caps are what actually protect the Resend quota.

## Run it locally

```bash
npm run build
npm run db:migrate:local          # local D1 under .wrangler/ (gitignored)
npm run dev:functions             # wrangler pages dev dist, http://localhost:8788
npx wrangler d1 execute apelles-waitlist --local \
  --command "SELECT email, status, confirm_token FROM waitlist"
# then open http://localhost:8788/api/confirm?token=<confirm_token>
```

Signups need a Turnstile secret, even locally. Put Cloudflare's documented
TEST keys in an untracked `website/.dev.vars` (gitignored). Test tokens come
back from siteverify with hostname `example.com`:

```
TURNSTILE_SECRET_KEY=1x0000000000000000000000000000000AA   # always passes (2x...AA always fails)
TURNSTILE_ALLOWED_HOSTNAMES=example.com
# CONFIRM_EMAILS_PER_DAY=0     # uncomment to watch the hold-back path
```

The page's widget uses the matching test site key (`1x00000000000000000000AA`)
automatically when `PUBLIC_TURNSTILE_SITE_KEY` is unset; the curl token is
`XXXX.DUMMY.TOKEN.XXXX`:

```bash
curl -X POST localhost:8788/api/waitlist -H 'content-type: application/json' \
  -d '{"email":"you@example.com","source":"hero","cf-turnstile-response":"XXXX.DUMMY.TOKEN.XXXX"}'
```

To send real mail locally, also put `RESEND_API_KEY=...` in `.dev.vars`.

## Export

```bash
npm run export:waitlist                      # confirmed addresses, CSV to stdout
npm run export:waitlist -- --status all --out waitlist.csv
npm run export:waitlist -- --local           # the local database
```

Columns: email, role, source, status, created_at, confirmed_at, unsubscribed_at
(ISO times). The tokens are never exported.

## Sending the launch email

1. Reconcile first, so nobody who unsubscribed through a broadcast footer is
   mailed again. Resend handles those unsubscribes itself and there is no
   webhook (D-426), so pull them back into D1:

   ```bash
   RESEND_API_KEY=... npm run sync:resend -- unsubscribes
   RESEND_API_KEY=... npm run sync:resend -- backfill   # retries resend_synced = 0 rows
   ```

   Needs Node 22.18+ (it runs the TypeScript directly). Add `--local` for the
   local database.
2. In the Resend dashboard, create a Broadcast to the **Apelles Beta** segment.
   Resend adds the unsubscribe footer and honours it.
3. Re-run `unsubscribes` afterwards to bring the new opt-outs home.

If you would rather send from another tool, `npm run export:waitlist` produces
the confirmed list as CSV.

## Limits and the plan beyond them (Resend free tier, checked 2026-10-29)

- Marketing contacts: **1,000** on the free plan. Transactional sends: **3,000
  a month, 100 a day**. Each signup costs one confirmation email. The caps
  (90 a day, 2,900 a month, D-427) hold the rest, and the drain Worker sends
  them in order as the budget returns, so a busy day delays some confirmations
  instead of dropping them. To raise the caps after upgrading Resend, change
  both `wrangler.toml` files.
- Past 1,000 confirmed contacts there are two options: pay for Resend's next
  contacts tier for the month the broadcast goes out, or export the CSV and
  send from another tool. D1 holds the whole list either way, so neither is a
  migration.

## Privacy

What is stored, and why, is on `/privacy/` (`src/pages/privacy.astro`); change
the table and that page in the same commit. The site loads no analytics of its
own and sets no cookies; the signup sets none.
