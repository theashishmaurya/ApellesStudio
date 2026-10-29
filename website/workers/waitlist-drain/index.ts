/**
 * website/workers/waitlist-drain/index.ts — the hourly drain of held
 * confirmation emails (D-427).
 *
 * What it is: a tiny Cloudflare Worker with a Cron Trigger. Pages Functions
 * have no cron, so this is the canonical way to run scheduled work against the
 * same D1 database. Each run sends the confirmation emails the signup handler
 * held back because the daily or monthly cap was reached, oldest first, within
 * whatever budget is left (functions/_lib/quota.ts `drainHeld`).
 * What it does NOT do: serve requests, accept signups or touch anything but
 * pending rows flagged `email_held`. It shares its logic with the Pages
 * Functions by importing ../../functions/_lib, so the budget rules exist once.
 *
 * Deployed separately from the site; see ./wrangler.toml and
 * website/BETA_SIGNUP_SETUP.md.
 */
import { drainHeld } from '../../functions/_lib/quota.ts';
import type { WaitlistEnv } from '../../functions/_lib/waitlist.ts';

interface DrainEnv extends WaitlistEnv {
  /** Origin the confirm and unsubscribe links in the email point at. */
  SITE_ORIGIN: string;
}

export default {
  async scheduled(_controller: unknown, env: DrainEnv): Promise<void> {
    await drainHeld(env, env.SITE_ORIGIN, Date.now());
  },
};
