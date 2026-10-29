# Beta waitlist — how it works, and how to run it

The signup forms (hero and the Beta section) post to the site's own waitlist
(D-426): a Cloudflare Pages Function, a D1 database and Resend. It replaced
FormSubmit.co, which was never a list. **D1 is the master list**; Resend holds a
copy of confirmed addresses only so broadcasts can be sent from its dashboard.

## How it works

```
form ──POST /api/waitlist──▶ validate, honeypot, size cap
                             INSERT OR IGNORE into D1 (status = pending)
                             Resend "send email": confirmation + List-Unsubscribe headers
inbox ──GET /api/confirm?token=──▶ status = confirmed ──▶ Resend contact + segment ──▶ /waitlist/confirmed/
inbox ──GET|POST /api/unsubscribe?token=──▶ status = unsubscribed ──▶ Resend contact unsubscribed ──▶ /waitlist/unsubscribed/
```

| file | role |
|---|---|
| `functions/api/{waitlist,confirm,unsubscribe}.ts` | the three routes, one-line adapters |
| `functions/_lib/waitlist.ts` | all the logic (tested over real SQLite, `tests/waitlist.test.ts`) |
| `functions/_lib/resend-contacts.ts` | the Resend Contacts API calls |
| `functions/_lib/email.ts` | the confirmation email (HTML + text) |
| `migrations/0001_waitlist.sql` | the table |
| `src/data/beta.ts` | endpoint, email rule and roles, shared by the forms and the function |
| `src/pages/waitlist/*.astro` | confirmed / unsubscribed / invalid-link pages (noindex, not in the sitemap) |
| `scripts/export-waitlist.mjs`, `scripts/sync-resend.ts` | CSV export; Resend reconcile + backfill |
| `wrangler.toml` | Pages config: `DB` binding, `MAIL_FROM`, `RESEND_THROTTLE_MINUTES`, `RESEND_SEGMENT_ID` |

Behaviours worth knowing:

- A signup always answers `{ ok: true }` for a valid address, whether it is new,
  pending, confirmed or returning, so the form cannot be used to find out who is
  on the list. The confirmation email is re-sent to a pending address at most
  once per `RESEND_THROTTLE_MINUTES` (10). Signing up again after unsubscribing
  is treated as consent again: back to pending with a fresh confirm link.
- Abuse limits that store nothing about the visitor: 4 KiB body cap, a hidden
  honeypot field (`company`), the email rule, the per-address throttle. No IP is
  stored or logged, which is what `/privacy/` promises. **Follow-up:** Cloudflare
  Turnstile if the form is ever abused to mail third parties.
- A Resend failure at confirm or unsubscribe never fails the visitor: it is
  logged and the row keeps `resend_synced = 0` for the backfill (below). A
  failure to send the confirmation email itself does return an error to the
  form, so the visitor can retry.
- Email security scanners sometimes open links in a message, which can confirm
  an address on the visitor's behalf. Acceptable for a beta list; the
  unsubscribe link has the same property.
- With no `RESEND_API_KEY` (local dev) the row is stored and the sending is
  skipped, with a warning in the log.

## One-time setup (the coordinator does the remote steps)

```bash
cd website && npm ci

# 1. The database schema, on the REMOTE database (the local one is below).
npx wrangler d1 migrations apply apelles-waitlist --remote

# 2. The Resend API key, as a Pages secret (it is never in the repo).
npx wrangler pages secret put RESEND_API_KEY --project-name=apelles-studio

# 3. Deploy (CI does this on a push to main touching website/).
```

The Resend domain `apelles.studio` must stay verified (sending only, tracking
off). The sender is `Apelles <hello@apelles.studio>` (`MAIL_FROM`). The segment
`Apelles Beta` is `RESEND_SEGMENT_ID`.

## Run it locally

```bash
npm run build
npm run db:migrate:local          # local D1 under .wrangler/ (gitignored)
npm run dev:functions             # wrangler pages dev dist, http://localhost:8788
curl -X POST localhost:8788/api/waitlist -H 'content-type: application/json' \
  -d '{"email":"you@example.com","source":"hero"}'
npx wrangler d1 execute apelles-waitlist --local \
  --command "SELECT email, status, confirm_token FROM waitlist"
# then open http://localhost:8788/api/confirm?token=<confirm_token>
```

To send real mail locally, put `RESEND_API_KEY=...` in an untracked
`website/.dev.vars` file.

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
  a month, 100 a day**. Each signup costs one confirmation email, so a day above
  100 signups defers the rest (they get the send-failed error and can retry).
- Past 1,000 confirmed contacts there are two options: pay for Resend's next
  contacts tier for the month the broadcast goes out, or export the CSV and
  send from another tool. D1 holds the whole list either way, so neither is a
  migration.

## Privacy

What is stored, and why, is on `/privacy/` (`src/pages/privacy.astro`); change
the table and that page in the same commit. The site loads no analytics of its
own and sets no cookies; the signup sets none.
