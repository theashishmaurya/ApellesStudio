/**
 * website/functions/_lib/quota.ts — the confirmation-email budget (D-427).
 *
 * What it is: how many confirmation emails may still be sent today and this
 * month, counted from D1's `email_sends` table (one row per email we handed to
 * Resend), and the drain that sends the ones held back when a cap was reached.
 * Resend's free plan allows 100 transactional emails a day and 3,000 a month;
 * the defaults sit just under both so a flood of fake signups cannot use the
 * quota real visitors need. Whichever cap is reached first holds the email.
 * What it does NOT do: count broadcasts (billed on the marketing plan, a
 * separate allowance) or know about other senders on the same Resend account;
 * the monthly default leaves headroom for those.
 *
 * Days and months are UTC calendar periods. Resend's monthly window may follow
 * the billing date instead, which is why the default is 2,900 and not 3,000.
 */
import { sendConfirmation } from './send.ts';
import type { Db, WaitlistEnv } from './waitlist.ts';

export const DEFAULT_PER_DAY = 90;
export const DEFAULT_PER_MONTH = 2900;
/**
 * Most held emails one drain sends. A Worker invocation on the free plan may
 * make 50 subrequests and each send costs a fetch plus D1 queries; the hourly
 * trigger still clears hundreds a day.
 */
export const MAX_DRAIN_PER_RUN = 20;

export interface QuotaEnv {
  DB: Db;
  CONFIRM_EMAILS_PER_DAY?: string;
  CONFIRM_EMAILS_PER_MONTH?: string;
}

function cap(value: string | undefined, fallback: number): number {
  const n = Number(value);
  return value !== undefined && Number.isInteger(n) && n >= 0 ? n : fallback;
}

function startOfUtcDay(now: number): number {
  return now - (now % 86_400_000);
}

function startOfUtcMonth(now: number): number {
  const d = new Date(now);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
}

async function countSince(db: Db, since: number): Promise<number> {
  const row = await db.prepare('SELECT COUNT(*) AS n FROM email_sends WHERE sent_at >= ?').bind(since).first<{ n: number }>();
  return row?.n ?? 0;
}

/** How many more confirmation emails may be sent right now: the tighter of the two caps. */
export async function remainingBudget(env: QuotaEnv, now: number): Promise<number> {
  const [today, month] = await Promise.all([
    countSince(env.DB, startOfUtcDay(now)),
    countSince(env.DB, startOfUtcMonth(now)),
  ]);
  const left = Math.min(
    cap(env.CONFIRM_EMAILS_PER_DAY, DEFAULT_PER_DAY) - today,
    cap(env.CONFIRM_EMAILS_PER_MONTH, DEFAULT_PER_MONTH) - month,
  );
  return Math.max(0, left);
}

export async function recordSend(db: Db, now: number): Promise<void> {
  await db.prepare('INSERT INTO email_sends (sent_at) VALUES (?)').bind(now).run();
}

interface HeldRow {
  id: number;
  email: string;
  confirm_token: string;
  unsubscribe_token: string;
}

/**
 * Sends held confirmations, oldest first, within the remaining budget. Stops at
 * the first failed send (Resend is down or rejecting: try again next run).
 * Returns how many were sent.
 */
export async function drainHeld(env: WaitlistEnv, origin: string, now: number): Promise<number> {
  if (!env.RESEND_API_KEY) {
    console.warn('waitlist drain: RESEND_API_KEY is not set; nothing sent');
    return 0;
  }
  const budget = Math.min(await remainingBudget(env, now), MAX_DRAIN_PER_RUN);
  if (budget === 0) return 0;

  const held = await env.DB.prepare(
    `SELECT id, email, confirm_token, unsubscribe_token FROM waitlist
     WHERE email_held = 1 AND status = 'pending' ORDER BY created_at, id LIMIT ?`,
  )
    .bind(budget)
    .all<HeldRow>();

  let sent = 0;
  for (const row of held.results) {
    if (!(await sendConfirmation(env, origin, row))) break;
    await recordSend(env.DB, now);
    await env.DB.prepare('UPDATE waitlist SET email_held = 0, last_email_at = ? WHERE id = ?').bind(now, row.id).run();
    sent += 1;
  }
  // A held row that is no longer pending (it unsubscribed meanwhile) must not stay queued.
  await env.DB.prepare("UPDATE waitlist SET email_held = 0 WHERE email_held = 1 AND status != 'pending'").run();
  console.log(`waitlist drain: sent ${sent} of ${held.results.length} held confirmations`);
  return sent;
}
