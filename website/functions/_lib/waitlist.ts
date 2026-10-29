/**
 * website/functions/_lib/waitlist.ts — the waitlist's logic (D-426).
 *
 * What it is: signup, confirm and unsubscribe as plain functions over a
 * D1-shaped database and the global `fetch` (Resend's HTTP API). The three
 * Pages Functions in functions/api/ are one-line adapters over these, so the
 * behaviour is unit-tested without a Workers runtime (tests/waitlist.test.ts).
 * D1 is the master list; confirm and unsubscribe also mirror the change to a
 * Resend contact (resend-contacts.ts), best effort, tracked by `resend_synced`.
 * What it does NOT do: store or log an IP address or any request header, send
 * anything but the confirmation email, or reveal whether an address is already
 * on the list — a signup answers the same `{ ok: true }` for a new address, a
 * pending one, a confirmed one and a returning one.
 *
 * Abuse limits that need no identifier (D-427): a hard body-size cap, a
 * honeypot, a strict email check, a disposable-domain blocklist, Cloudflare
 * Turnstile, a per-address throttle on the confirmation email, and daily and
 * monthly caps on all confirmation emails (an email over a cap is held and sent
 * later by the drain Worker, workers/waitlist-drain/).
 */
import { isValidEmail, ROLES } from '../../src/data/beta.ts';
import { isDisposableEmail } from '../../src/data/disposable-domains.ts';
import { recordSend, remainingBudget, type QuotaEnv } from './quota.ts';
import { addConfirmedContact, unsubscribeContact } from './resend-contacts.ts';
import { RESEND_ENDPOINT, sendConfirmation, type SendEnv } from './send.ts';
import { TURNSTILE_FIELD, verifyTurnstile, type TurnstileEnv } from './turnstile.ts';

export { RESEND_ENDPOINT };

/** Largest request body accepted; a real signup is a few hundred bytes. */
export const MAX_BODY_BYTES = 4096;
/** RFC 5321 path limit; also bounds what is written to the table. */
export const MAX_EMAIL_LENGTH = 254;
export const HONEYPOT_FIELD = 'company';
const DEFAULT_THROTTLE_MINUTES = 10;
const SOURCE_PATTERN = /^[a-z0-9_-]{1,32}$/;
const TOKEN_BYTES = 24;

/** The slice of a D1 prepared statement this module uses. */
export interface DbStatement {
  bind(...values: unknown[]): DbStatement;
  first<T>(): Promise<T | null>;
  all<T>(): Promise<{ results: T[] }>;
  run(): Promise<unknown>;
}
/** The slice of a D1 database this module uses; `D1Database` satisfies it. */
export interface Db {
  prepare(sql: string): DbStatement;
}

export interface WaitlistEnv extends SendEnv, TurnstileEnv, QuotaEnv {
  DB: Db;
  /** The Resend segment confirmed addresses join; absent = no contact sync. */
  RESEND_SEGMENT_ID?: string;
  RESEND_THROTTLE_MINUTES?: string;
}

export type WaitlistStatus = 'pending' | 'confirmed' | 'unsubscribed';

interface Row {
  id: number;
  email: string;
  status: WaitlistStatus;
  confirm_token: string;
  unsubscribe_token: string;
  last_email_at: number | null;
  resend_synced: 0 | 1;
  email_held: 0 | 1;
}

function json(body: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
}

function redirect(origin: string, path: string): Response {
  return new Response(null, { status: 303, headers: { location: new URL(path, origin).href } });
}

function newToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(TOKEN_BYTES));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

interface Fields {
  email: string;
  role: string;
  source: string;
  company: string;
  turnstile: string;
}

/** Reads the body as JSON or a form post; `null` when it is oversized or unreadable. */
async function readFields(request: Request): Promise<Fields | null> {
  const declared = Number(request.headers.get('content-length') ?? '0');
  if (declared > MAX_BODY_BYTES) return null;
  const raw = await request.arrayBuffer();
  if (raw.byteLength > MAX_BODY_BYTES) return null;

  const text = (value: unknown): string => (typeof value === 'string' ? value : '');
  const type = request.headers.get('content-type') ?? '';
  try {
    if (type.includes('application/json')) {
      const body: unknown = JSON.parse(new TextDecoder().decode(raw));
      if (typeof body !== 'object' || body === null) return null;
      const o = body as Record<string, unknown>;
      return {
        email: text(o.email),
        role: text(o.role),
        source: text(o.source),
        company: text(o[HONEYPOT_FIELD]),
        turnstile: text(o[TURNSTILE_FIELD]),
      };
    }
    const form = await new Response(raw, { headers: { 'content-type': type } }).formData();
    return {
      email: text(form.get('email')),
      role: text(form.get('role')),
      source: text(form.get('source')),
      company: text(form.get(HONEYPOT_FIELD)),
      turnstile: text(form.get(TURNSTILE_FIELD)),
    };
  } catch {
    return null;
  }
}

/** POST /api/waitlist */
export async function signup(request: Request, env: WaitlistEnv, now: number = Date.now()): Promise<Response> {
  const fields = await readFields(request);
  if (!fields) return json({ error: 'bad_request' }, 413);

  // A filled honeypot is a bot. Answer like a success so it learns nothing.
  if (fields.company.trim() !== '') return json({ ok: true });

  const email = fields.email.trim().toLowerCase();
  // A throwaway-mailbox domain gets the same answer as a malformed address.
  if (email.length > MAX_EMAIL_LENGTH || !isValidEmail(email) || isDisposableEmail(email)) {
    return json({ error: 'invalid_email' }, 400);
  }

  // Cheap checks first, so a bad address never costs a Turnstile round trip.
  const human = await verifyTurnstile(fields.turnstile, env, new URL(request.url).hostname);
  if (human === 'unavailable') return json({ error: 'unavailable' }, 503);
  if (human === 'rejected') return json({ error: 'captcha_failed' }, 403);
  const role = (ROLES as readonly string[]).includes(fields.role) ? fields.role : null;
  const source = SOURCE_PATTERN.test(fields.source) ? fields.source : null;

  await env.DB.prepare(
    `INSERT OR IGNORE INTO waitlist (email, role, source, confirm_token, unsubscribe_token, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  )
    .bind(email, role, source, newToken(), newToken(), now)
    .run();

  let row = await env.DB.prepare('SELECT * FROM waitlist WHERE email = ?').bind(email).first<Row>();
  if (!row) return json({ error: 'unavailable' }, 503);
  if (row.status === 'confirmed') return json({ ok: true });

  if (row.status === 'unsubscribed') {
    // Asking again is consent again: back to pending with a fresh confirm link.
    const confirmToken = newToken();
    await env.DB.prepare(
      "UPDATE waitlist SET status = 'pending', confirm_token = ?, unsubscribed_at = NULL, last_email_at = NULL, email_held = 0, resend_synced = 0 WHERE id = ?",
    )
      .bind(confirmToken, row.id)
      .run();
    row = { ...row, status: 'pending', confirm_token: confirmToken, last_email_at: null, email_held: 0 };
  }

  const throttleMinutes = Number(env.RESEND_THROTTLE_MINUTES ?? DEFAULT_THROTTLE_MINUTES);
  const throttleMs = (Number.isFinite(throttleMinutes) ? throttleMinutes : DEFAULT_THROTTLE_MINUTES) * 60_000;
  if (row.last_email_at !== null && now - row.last_email_at < throttleMs) return json({ ok: true });

  // Already queued behind a cap: the drain sends it, asking again changes nothing.
  if (row.email_held === 1) return json({ ok: true });

  // Over the daily or monthly cap: keep the row, hold the email, answer as usual.
  if ((await remainingBudget(env, now)) === 0) {
    await env.DB.prepare('UPDATE waitlist SET email_held = 1 WHERE id = ?').bind(row.id).run();
    console.warn('waitlist: confirmation email cap reached; held a confirmation for the drain Worker');
    return json({ ok: true });
  }

  const origin = new URL(request.url).origin;
  if (!(await sendConfirmation(env, origin, row))) return json({ error: 'send_failed' }, 502);
  if (env.RESEND_API_KEY) await recordSend(env.DB, now);
  await env.DB.prepare('UPDATE waitlist SET last_email_at = ? WHERE id = ?').bind(now, row.id).run();
  return json({ ok: true });
}

async function markSynced(env: WaitlistEnv, id: number): Promise<void> {
  await env.DB.prepare('UPDATE waitlist SET resend_synced = 1 WHERE id = ?').bind(id).run();
}

function tokenOf(request: Request): { origin: string; token: string } {
  const url = new URL(request.url);
  return { origin: url.origin, token: url.searchParams.get('token') ?? '' };
}

/** GET /api/confirm?token= */
export async function confirm(request: Request, env: WaitlistEnv, now: number = Date.now()): Promise<Response> {
  const { origin, token } = tokenOf(request);
  const row = token
    ? await env.DB.prepare('SELECT * FROM waitlist WHERE confirm_token = ?').bind(token).first<Row>()
    : null;
  // An unsubscribed address cannot be revived by an old confirm link.
  if (!row || row.status === 'unsubscribed') return redirect(origin, '/waitlist/invalid/');
  if (row.status === 'pending') {
    await env.DB.prepare("UPDATE waitlist SET status = 'confirmed', confirmed_at = ?, resend_synced = 0 WHERE id = ?")
      .bind(now, row.id)
      .run();
  }
  // Best effort: a Resend failure is logged and left for the backfill, never shown to the visitor.
  if (row.status === 'pending' || row.resend_synced === 0) {
    if (await addConfirmedContact(env, row.email)) await markSynced(env, row.id);
  }
  return redirect(origin, '/waitlist/confirmed/');
}

/** GET (the link in the email) and POST (RFC 8058 one-click) /api/unsubscribe?token= */
export async function unsubscribe(request: Request, env: WaitlistEnv, now: number = Date.now()): Promise<Response> {
  const { origin, token } = tokenOf(request);
  const oneClick = request.method === 'POST';
  const row = token
    ? await env.DB.prepare('SELECT * FROM waitlist WHERE unsubscribe_token = ?').bind(token).first<Row>()
    : null;
  if (!row) return oneClick ? json({ error: 'unknown_token' }, 404) : redirect(origin, '/waitlist/invalid/');
  if (row.status !== 'unsubscribed') {
    await env.DB.prepare(
      "UPDATE waitlist SET status = 'unsubscribed', unsubscribed_at = ?, resend_synced = 0 WHERE id = ?",
    )
      .bind(now, row.id)
      .run();
  }
  if (row.status !== 'unsubscribed' || row.resend_synced === 0) {
    if (await unsubscribeContact(env, row.email)) await markSynced(env, row.id);
  }
  return oneClick ? json({ ok: true }) : redirect(origin, '/waitlist/unsubscribed/');
}
