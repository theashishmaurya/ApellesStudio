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
 * Abuse limits that need no identifier: a hard body-size cap, a honeypot, a
 * strict email check, and a per-address throttle on the confirmation email.
 * Cloudflare Turnstile is a follow-up (docs/04-roadmap.md).
 */
import { isValidEmail, ROLES } from '../../src/data/beta.ts';
import { confirmationEmail } from './email.ts';
import { addConfirmedContact, unsubscribeContact } from './resend-contacts.ts';

/** Largest request body accepted; a real signup is a few hundred bytes. */
export const MAX_BODY_BYTES = 4096;
/** RFC 5321 path limit; also bounds what is written to the table. */
export const MAX_EMAIL_LENGTH = 254;
export const HONEYPOT_FIELD = 'company';
export const RESEND_ENDPOINT = 'https://api.resend.com/emails';
const DEFAULT_THROTTLE_MINUTES = 10;
const SOURCE_PATTERN = /^[a-z0-9_-]{1,32}$/;
const TOKEN_BYTES = 24;

/** The slice of a D1 prepared statement this module uses. */
export interface DbStatement {
  bind(...values: unknown[]): DbStatement;
  first<T>(): Promise<T | null>;
  run(): Promise<unknown>;
}
/** The slice of a D1 database this module uses; `D1Database` satisfies it. */
export interface Db {
  prepare(sql: string): DbStatement;
}

export interface WaitlistEnv {
  DB: Db;
  /** Pages secret. Absent in local dev: rows are stored, nothing is sent. */
  RESEND_API_KEY?: string;
  /** The Resend segment confirmed addresses join; absent = no contact sync. */
  RESEND_SEGMENT_ID?: string;
  MAIL_FROM: string;
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
      return { email: text(o.email), role: text(o.role), source: text(o.source), company: text(o[HONEYPOT_FIELD]) };
    }
    const form = await new Response(raw, { headers: { 'content-type': type } }).formData();
    return {
      email: text(form.get('email')),
      role: text(form.get('role')),
      source: text(form.get('source')),
      company: text(form.get(HONEYPOT_FIELD)),
    };
  } catch {
    return null;
  }
}

async function sendConfirmation(env: WaitlistEnv, origin: string, row: Row): Promise<boolean> {
  if (!env.RESEND_API_KEY) {
    console.warn('waitlist: RESEND_API_KEY is not set; stored the signup and skipped the email');
    return true;
  }
  const confirmUrl = `${origin}/api/confirm?token=${row.confirm_token}`;
  const unsubscribeUrl = `${origin}/api/unsubscribe?token=${row.unsubscribe_token}`;
  const mail = confirmationEmail(confirmUrl, unsubscribeUrl);
  const res = await fetch(RESEND_ENDPOINT, {
    method: 'POST',
    headers: { authorization: `Bearer ${env.RESEND_API_KEY}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      from: env.MAIL_FROM,
      to: [row.email],
      subject: mail.subject,
      html: mail.html,
      text: mail.text,
      headers: {
        'List-Unsubscribe': `<${unsubscribeUrl}>`,
        'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
      },
    }),
  });
  if (!res.ok) console.error(`waitlist: Resend answered ${res.status}`);
  return res.ok;
}

/** POST /api/waitlist */
export async function signup(request: Request, env: WaitlistEnv, now: number = Date.now()): Promise<Response> {
  const fields = await readFields(request);
  if (!fields) return json({ error: 'bad_request' }, 413);

  // A filled honeypot is a bot. Answer like a success so it learns nothing.
  if (fields.company.trim() !== '') return json({ ok: true });

  const email = fields.email.trim().toLowerCase();
  if (email.length > MAX_EMAIL_LENGTH || !isValidEmail(email)) return json({ error: 'invalid_email' }, 400);
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
      "UPDATE waitlist SET status = 'pending', confirm_token = ?, unsubscribed_at = NULL, last_email_at = NULL, resend_synced = 0 WHERE id = ?",
    )
      .bind(confirmToken, row.id)
      .run();
    row = { ...row, status: 'pending', confirm_token: confirmToken, last_email_at: null };
  }

  const throttleMinutes = Number(env.RESEND_THROTTLE_MINUTES ?? DEFAULT_THROTTLE_MINUTES);
  const throttleMs = (Number.isFinite(throttleMinutes) ? throttleMinutes : DEFAULT_THROTTLE_MINUTES) * 60_000;
  if (row.last_email_at !== null && now - row.last_email_at < throttleMs) return json({ ok: true });

  const origin = new URL(request.url).origin;
  if (!(await sendConfirmation(env, origin, row))) return json({ error: 'send_failed' }, 502);
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
