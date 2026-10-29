/**
 * waitlist.test.ts — the waitlist handlers (D-426), end to end over a real
 * SQLite database built from the real migration (node:sqlite stands in for D1,
 * which is SQLite) and a mocked `fetch` standing in for Resend. Cloudflare's
 * Turnstile siteverify has its own mock (`turnstileMock`) so the Resend call
 * assertions stay about Resend. D-427 added Turnstile, the disposable-domain
 * blocklist and the daily/monthly confirmation caps with their drain.
 */
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  confirm,
  MAX_BODY_BYTES,
  RESEND_ENDPOINT,
  signup,
  unsubscribe,
  type Db,
  type DbStatement,
  type WaitlistEnv,
} from '../functions/_lib/waitlist.ts';
import { CONFIRM_SUBJECT } from '../functions/_lib/email.ts';
import { listUnsubscribedContacts } from '../functions/_lib/resend-contacts.ts';
import { drainHeld, MAX_DRAIN_PER_RUN, remainingBudget } from '../functions/_lib/quota.ts';
import { TURNSTILE_FIELD, TURNSTILE_VERIFY_URL } from '../functions/_lib/turnstile.ts';
import { ROLES } from '../src/data/beta.ts';
import { DISPOSABLE_DOMAINS, isDisposableEmail } from '../src/data/disposable-domains.ts';

const ORIGIN = 'https://apelles.studio';
const MIGRATIONS = ['0001_waitlist.sql', '0002_abuse_limits.sql'].map((f) =>
  readFileSync(new URL(`../migrations/${f}`, import.meta.url), 'utf8'),
);
const T0 = 1_800_000_000_000;
const MINUTE = 60_000;

type SqlValue = string | number | null;
interface Row {
  email: string;
  role: string | null;
  source: string | null;
  status: string;
  confirm_token: string;
  unsubscribe_token: string;
  created_at: number;
  last_email_at: number | null;
  confirmed_at: number | null;
  unsubscribed_at: number | null;
  resend_synced: number;
  email_held: number;
}

function d1Over(sqlite: DatabaseSync): Db {
  const statement = (sql: string, values: SqlValue[] = []): DbStatement => ({
    bind: (...v: unknown[]) => statement(sql, v as SqlValue[]),
    first: async <T>() => (sqlite.prepare(sql).get(...values) as T | undefined) ?? null,
    all: async <T>() => ({ results: sqlite.prepare(sql).all(...values) as T[] }),
    run: async () => sqlite.prepare(sql).run(...values),
  });
  return { prepare: (sql) => statement(sql) };
}

let sqlite: DatabaseSync;
let env: WaitlistEnv;
let fetchMock: ReturnType<typeof vi.fn>;
let turnstileMock: ReturnType<typeof vi.fn>;
const GOOD_TOKEN = 'XXXX.DUMMY.TOKEN.XXXX';

const rows = () => sqlite.prepare('SELECT * FROM waitlist ORDER BY id').all() as unknown as Row[];
const row = (email: string) => rows().find((r) => r.email === email) as Row;

/** A signup request; carries a Turnstile token unless `token` says otherwise (`null` = none). */
function post(body: unknown, init: { type?: string; raw?: string; token?: string | null } = {}): Request {
  const type = init.type ?? 'application/json';
  const token = init.token === undefined ? GOOD_TOKEN : init.token;
  const withToken =
    token !== null && typeof body === 'object' && body !== null ? { ...body, [TURNSTILE_FIELD]: token } : body;
  return new Request(`${ORIGIN}/api/waitlist`, {
    method: 'POST',
    headers: { 'content-type': type },
    body: init.raw ?? JSON.stringify(withToken),
  });
}

const SEGMENT = 'seg-123';
type Call = [string, { method: string; body?: string }];
const calls = () => fetchMock.mock.calls as unknown as Call[];
/** Confirmation emails handed to Resend (as opposed to contact-API calls). */
const mailCalls = () => calls().filter(([url]) => url === RESEND_ENDPOINT);
/** Contact-API calls as "METHOD path-after-/contacts". */
const contactCalls = () =>
  calls()
    .filter(([url]) => url.startsWith('https://api.resend.com/contacts'))
    .map(([url, init]) => `${init.method} ${decodeURIComponent(url.slice('https://api.resend.com/contacts'.length))}`);
const sentMail = () => JSON.parse(mailCalls()[0][1].body as string);

beforeEach(() => {
  sqlite = new DatabaseSync(':memory:');
  for (const migration of MIGRATIONS) sqlite.exec(migration);
  env = {
    DB: d1Over(sqlite),
    RESEND_API_KEY: 'test-key',
    RESEND_SEGMENT_ID: SEGMENT,
    MAIL_FROM: 'Ashish from Apelles <hello@mail.apelles.studio>',
    MAIL_REPLY_TO: 'hello@apelles.studio',
    // Cloudflare's documented always-pass TEST secret; the mock below answers for it.
    TURNSTILE_SECRET_KEY: '1x0000000000000000000000000000000AA',
  };
  fetchMock = vi.fn(async () => new Response('{"id":"x"}', { status: 200 }));
  turnstileMock = vi.fn(async () => Response.json({ success: true, hostname: 'apelles.studio' }));
  vi.stubGlobal('fetch', (url: string, init: unknown) =>
    url === TURNSTILE_VERIFY_URL ? turnstileMock(url, init) : fetchMock(url, init),
  );
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  sqlite.close();
});

describe('signup', () => {
  it('stores a valid address lowercased, pending, and sends the confirmation through Resend', async () => {
    const res = await signup(post({ email: '  Someone@Example.COM ', role: ROLES[0], source: 'hero' }), env, T0);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });

    const [r] = rows();
    expect(r).toMatchObject({
      email: 'someone@example.com',
      role: ROLES[0],
      source: 'hero',
      status: 'pending',
      created_at: T0,
      last_email_at: T0,
      confirmed_at: null,
    });
    expect(r.confirm_token).not.toBe(r.unsubscribe_token);
    expect(r.confirm_token.length).toBeGreaterThanOrEqual(32);

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(RESEND_ENDPOINT);
    expect(init.headers.authorization).toBe('Bearer test-key');
    const mail = sentMail();
    expect(mail.from).toBe('Ashish from Apelles <hello@mail.apelles.studio>');
    expect(mail.reply_to).toBe('hello@apelles.studio');
    expect(mail.to).toEqual(['someone@example.com']);
    expect(mail.subject).toBe(CONFIRM_SUBJECT);
    expect(mail.html).toContain(`${ORIGIN}/api/confirm?token=${r.confirm_token}`);
    expect(mail.text).toContain(`${ORIGIN}/api/confirm?token=${r.confirm_token}`);
    // A personal transactional note: no bulk-mail headers, no unsubscribe link.
    expect(mail.headers).toBeUndefined();
    expect(mail.html).not.toMatch(/unsubscribe/i);
    expect(mail.text).not.toMatch(/unsubscribe/i);
    expect(mail.subject).toBe('Confirm your email for the Apelles beta');
    expect(mail.from).toBe('Ashish from Apelles <hello@mail.apelles.studio>');
    expect(mail.text.split('\n')[0]).toBe('Click to confirm. This link expires in 7 days.');
    expect(mail.html).toContain("Didn't ask for this? Ignore it");
  });

  it('sends through the Resend template, with the confirm link as its one variable, when one is configured', async () => {
    env.CONFIRM_TEMPLATE = 'beta-confirm';
    const res = await signup(post({ email: 'tpl@example.com' }), env, T0);
    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const mail = sentMail();
    const [r] = rows();
    expect(mail.template).toEqual({
      id: 'beta-confirm',
      variables: { CONFIRM_URL: `${ORIGIN}/api/confirm?token=${r.confirm_token}` },
    });
    expect(mail.from).toBe('Ashish from Apelles <hello@mail.apelles.studio>');
    expect(mail.reply_to).toBe('hello@apelles.studio');
    // Resend refuses html/text alongside a template.
    expect(mail.html).toBeUndefined();
    expect(mail.text).toBeUndefined();
  });

  it('falls back to the built-in email when Resend rejects the template', async () => {
    env.CONFIRM_TEMPLATE = 'beta-confirm';
    fetchMock.mockImplementationOnce(async () => new Response('{"message":"template not found"}', { status: 422 }));
    const res = await signup(post({ email: 'fallback@example.com' }), env, T0);
    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const fallback = JSON.parse(fetchMock.mock.calls[1][1].body);
    expect(fallback.template).toBeUndefined();
    expect(fallback.subject).toBe(CONFIRM_SUBJECT);
    expect(fallback.text).toContain(`${ORIGIN}/api/confirm?token=`);
    expect(rows()[0].last_email_at).toBe(T0);
  });

  it('accepts a classic form post too', async () => {
    const res = await signup(
      post(null, { type: 'application/x-www-form-urlencoded', raw: `email=form%40example.com&source=beta&${TURNSTILE_FIELD}=${GOOD_TOKEN}` }),
      env,
      T0,
    );
    expect(res.status).toBe(200);
    expect(row('form@example.com').source).toBe('beta');
  });

  it('keeps an unknown role and a malformed source out of the table', async () => {
    await signup(post({ email: 'a@example.com', role: 'Wizard', source: '<script>' }), env, T0);
    expect(row('a@example.com')).toMatchObject({ role: null, source: null });
  });

  it.each(['', 'nope', 'no@domain', 'two @spaces.com'])('rejects the invalid address %j', async (email) => {
    const res = await signup(post({ email }), env, T0);
    expect(res.status).toBe(400);
    expect(rows()).toHaveLength(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects an address longer than the SMTP limit', async () => {
    const res = await signup(post({ email: `${'a'.repeat(250)}@example.com` }), env, T0);
    expect(res.status).toBe(400);
  });

  it('answers a filled honeypot like a success but stores and sends nothing', async () => {
    const res = await signup(post({ email: 'bot@example.com', company: 'Acme' }), env, T0);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(rows()).toHaveLength(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects an oversized body, by declared length and by actual size', async () => {
    const big = JSON.stringify({ email: 'a@example.com', pad: 'x'.repeat(MAX_BODY_BYTES) });
    const declared = new Request(`${ORIGIN}/api/waitlist`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': String(big.length) },
      body: big,
    });
    expect((await signup(declared, env, T0)).status).toBe(413);
    expect((await signup(post(null, { raw: big }), env, T0)).status).toBe(413);
    expect(rows()).toHaveLength(0);
  });

  it('rejects a body that is not parseable', async () => {
    expect((await signup(post(null, { raw: '{not json' }), env, T0)).status).toBe(413);
  });

  it('does not leak whether an address exists: a duplicate gets the identical response', async () => {
    const first = await signup(post({ email: 'dup@example.com' }), env, T0);
    const again = await signup(post({ email: 'DUP@example.com' }), env, T0 + MINUTE);
    expect(again.status).toBe(first.status);
    expect(await again.json()).toEqual(await first.json());
    expect(rows()).toHaveLength(1);
  });

  it('throttles the confirmation email for a pending address, then sends again after the window', async () => {
    await signup(post({ email: 'slow@example.com' }), env, T0);
    await signup(post({ email: 'slow@example.com' }), env, T0 + 5 * MINUTE);
    expect(mailCalls()).toHaveLength(1);

    await signup(post({ email: 'slow@example.com' }), env, T0 + 11 * MINUTE);
    expect(mailCalls()).toHaveLength(2);
    expect(row('slow@example.com').last_email_at).toBe(T0 + 11 * MINUTE);
  });

  it('honours RESEND_THROTTLE_MINUTES', async () => {
    env.RESEND_THROTTLE_MINUTES = '1';
    await signup(post({ email: 'fast@example.com' }), env, T0);
    await signup(post({ email: 'fast@example.com' }), env, T0 + 2 * MINUTE);
    expect(mailCalls()).toHaveLength(2);
  });

  it('sends nothing to an already confirmed address', async () => {
    await signup(post({ email: 'done@example.com' }), env, T0);
    sqlite.exec("UPDATE waitlist SET status = 'confirmed'");
    const res = await signup(post({ email: 'done@example.com' }), env, T0 + 60 * MINUTE);
    expect(res.status).toBe(200);
    expect(mailCalls()).toHaveLength(1);
    expect(row('done@example.com').status).toBe('confirmed');
  });

  it('treats a signup from an unsubscribed address as consent again: pending, fresh confirm link', async () => {
    await signup(post({ email: 'back@example.com' }), env, T0);
    const before = row('back@example.com');
    await unsubscribe(new Request(`${ORIGIN}/api/unsubscribe?token=${before.unsubscribe_token}`), env, T0 + MINUTE);
    await signup(post({ email: 'back@example.com' }), env, T0 + 2 * MINUTE);

    const after = row('back@example.com');
    expect(after.status).toBe('pending');
    expect(after.unsubscribed_at).toBeNull();
    expect(after.confirm_token).not.toBe(before.confirm_token);
    expect(after.unsubscribe_token).toBe(before.unsubscribe_token);
    expect(mailCalls()).toHaveLength(2);
  });

  it('hides a failed send from the visitor: normal ok, row held for the drain, nothing counted', async () => {
    fetchMock.mockResolvedValueOnce(new Response('nope', { status: 500 }));
    const res = await signup(post({ email: 'retry@example.com' }), env, T0);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(row('retry@example.com')).toMatchObject({ email_held: 1, last_email_at: null });
    expect(console.error).toHaveBeenCalled();
    expect(await remainingBudget(env, T0)).toBe(90);

    // The drain retries it; only that successful send is counted.
    expect(await drainHeld(env, ORIGIN, T0 + 60 * MINUTE)).toBe(1);
    expect(row('retry@example.com').email_held).toBe(0);
    expect(await remainingBudget(env, T0 + 60 * MINUTE)).toBe(89);
  });

  it('hides a network error on send the same way', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('network down'));
    const res = await signup(post({ email: 'net@example.com' }), env, T0);
    expect(res.status).toBe(200);
    expect(row('net@example.com').email_held).toBe(1);
  });

  it('without RESEND_API_KEY stores the row, skips the send, and says so in the log', async () => {
    delete env.RESEND_API_KEY;
    const res = await signup(post({ email: 'local@example.com' }), env, T0);
    expect(res.status).toBe(200);
    expect(rows()).toHaveLength(1);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('RESEND_API_KEY is not set'));
  });

  it('stores no request metadata: the table has no column for an address or a header', () => {
    const columns = (sqlite.prepare('PRAGMA table_info(waitlist)').all() as unknown as { name: string }[]).map(
      (c) => c.name,
    );
    expect(columns).toEqual([
      'id',
      'email',
      'role',
      'source',
      'status',
      'confirm_token',
      'unsubscribe_token',
      'created_at',
      'last_email_at',
      'confirmed_at',
      'unsubscribed_at',
      'resend_synced',
      'email_held',
    ]);
  });
});

describe('Turnstile (D-427)', () => {
  const body = { email: 'human@example.com' };

  it('sends the token and the secret to siteverify and admits the signup', async () => {
    expect((await signup(post(body), env, T0)).status).toBe(200);
    const [url, init] = turnstileMock.mock.calls[0];
    expect(url).toBe(TURNSTILE_VERIFY_URL);
    expect(JSON.parse(init.body)).toEqual({ secret: env.TURNSTILE_SECRET_KEY, response: GOOD_TOKEN });
    expect(rows()).toHaveLength(1);
  });

  it('accepts the token on a classic form post as well', async () => {
    const raw = `email=f%40example.com&${TURNSTILE_FIELD}=${GOOD_TOKEN}`;
    expect((await signup(post(null, { type: 'application/x-www-form-urlencoded', raw }), env, T0)).status).toBe(200);
  });

  it('refuses a failed verification with 403 and stores and sends nothing', async () => {
    turnstileMock.mockResolvedValue(Response.json({ success: false, 'error-codes': ['invalid-input-response'] }));
    const res = await signup(post(body), env, T0);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'captcha_failed' });
    expect(rows()).toHaveLength(0);
    expect(mailCalls()).toHaveLength(0);
  });

  it('refuses a missing token without asking Cloudflare', async () => {
    const res = await signup(post(body, { token: null }), env, T0);
    expect(res.status).toBe(403);
    expect(turnstileMock).not.toHaveBeenCalled();
    expect(rows()).toHaveLength(0);
  });

  it('refuses a token issued for another hostname', async () => {
    turnstileMock.mockResolvedValue(Response.json({ success: true, hostname: 'evil.example' }));
    expect((await signup(post(body), env, T0)).status).toBe(403);
  });

  it('checks the hostname against TURNSTILE_ALLOWED_HOSTNAMES when set', async () => {
    env.TURNSTILE_ALLOWED_HOSTNAMES = 'apelles.studio, www.apelles.studio';
    turnstileMock.mockResolvedValue(Response.json({ success: true, hostname: 'www.apelles.studio' }));
    expect((await signup(post(body), env, T0)).status).toBe(200);
    turnstileMock.mockResolvedValue(Response.json({ success: true, hostname: 'example.com' }));
    expect((await signup(post({ email: 'x@example.com' }), env, T0)).status).toBe(403);
  });

  it('fails closed with a clear log when the secret is missing', async () => {
    delete env.TURNSTILE_SECRET_KEY;
    const res = await signup(post(body), env, T0);
    expect(res.status).toBe(503);
    expect(rows()).toHaveLength(0);
    expect(turnstileMock).not.toHaveBeenCalled();
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('TURNSTILE_SECRET_KEY is not set'));
  });

  it('fails closed when siteverify is down or unreachable', async () => {
    turnstileMock.mockResolvedValue(new Response('down', { status: 500 }));
    expect((await signup(post(body), env, T0)).status).toBe(503);
    turnstileMock.mockRejectedValue(new Error('offline'));
    expect((await signup(post(body), env, T0)).status).toBe(503);
    expect(rows()).toHaveLength(0);
  });

  it('keeps the duplicate response identical (no leak) with Turnstile in front', async () => {
    const first = await signup(post(body), env, T0);
    const again = await signup(post(body), env, T0 + MINUTE);
    expect(await again.json()).toEqual(await first.json());
  });
});

describe('disposable-address blocklist (D-427)', () => {
  it.each(['x@hopefunder.com', 'X@HopeFunder.com', 'a@mailinator.com', 'a@sub.mailinator.com'])(
    'rejects %s with the same error as an invalid address, before Turnstile',
    async (email) => {
      const res = await signup(post({ email }), env, T0);
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: 'invalid_email' });
      expect(turnstileMock).not.toHaveBeenCalled();
      expect(rows()).toHaveLength(0);
    },
  );

  it('lets ordinary providers and look-alike domains through', () => {
    for (const e of ['a@gmail.com', 'a@example.com', 'a@notmailinator.com', 'a@mailinator.com.au']) {
      expect(isDisposableEmail(e)).toBe(false);
    }
  });

  it('holds only lowercase, bare domains', () => {
    for (const d of DISPOSABLE_DOMAINS) expect(d).toMatch(/^[a-z0-9-]+(\.[a-z0-9-]+)+$/);
  });
});

describe('confirmation-email caps and the drain (D-427)', () => {
  const sends = () => (sqlite.prepare('SELECT COUNT(*) AS n FROM email_sends').get() as { n: number }).n;
  const held = () => rows().filter((r) => r.email_held === 1).map((r) => r.email);

  it('counts every confirmation sent', async () => {
    await signup(post({ email: 'a@example.com' }), env, T0);
    await signup(post({ email: 'b@example.com' }), env, T0);
    expect(sends()).toBe(2);
  });

  it('over the daily cap: stores the row pending, sends nothing, still answers success', async () => {
    env.CONFIRM_EMAILS_PER_DAY = '2';
    await signup(post({ email: 'a@example.com' }), env, T0);
    await signup(post({ email: 'b@example.com' }), env, T0);
    const res = await signup(post({ email: 'c@example.com' }), env, T0);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(mailCalls()).toHaveLength(2);
    expect(row('c@example.com')).toMatchObject({ status: 'pending', email_held: 1, last_email_at: null });
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('cap reached'));
  });

  it('over the monthly cap holds too, even when the day has room', async () => {
    env.CONFIRM_EMAILS_PER_MONTH = '1';
    await signup(post({ email: 'a@example.com' }), env, T0);
    await signup(post({ email: 'b@example.com' }), env, T0 + 3 * 86_400_000);
    expect(mailCalls()).toHaveLength(1);
    expect(held()).toEqual(['b@example.com']);
  });

  it('the day cap resets at the next UTC midnight, the month cap at the next month', async () => {
    env.CONFIRM_EMAILS_PER_DAY = '1';
    env.CONFIRM_EMAILS_PER_MONTH = '2';
    const day = Date.UTC(2026, 10, 3, 12);
    await signup(post({ email: 'a@example.com' }), env, day);
    expect(await remainingBudget(env, day)).toBe(0);
    expect(await remainingBudget(env, day + 86_400_000)).toBe(1);
    await signup(post({ email: 'b@example.com' }), env, day + 86_400_000);
    expect(await remainingBudget(env, day + 2 * 86_400_000)).toBe(0);
    expect(await remainingBudget(env, Date.UTC(2026, 11, 1))).toBe(1);
  });

  it('a held address asking again changes nothing', async () => {
    env.CONFIRM_EMAILS_PER_DAY = '0';
    await signup(post({ email: 'a@example.com' }), env, T0);
    await signup(post({ email: 'a@example.com' }), env, T0 + 20 * MINUTE);
    expect(held()).toEqual(['a@example.com']);
    expect(mailCalls()).toHaveLength(0);
  });

  it('a failed Resend send is not counted against the quota', async () => {
    fetchMock.mockResolvedValueOnce(new Response('nope', { status: 500 }));
    await signup(post({ email: 'a@example.com' }), env, T0);
    expect(sends()).toBe(0);
  });

  it('local dev (no Resend key) counts nothing', async () => {
    delete env.RESEND_API_KEY;
    await signup(post({ email: 'a@example.com' }), env, T0);
    expect(sends()).toBe(0);
  });

  describe('drainHeld', () => {
    async function holdThree() {
      env.CONFIRM_EMAILS_PER_DAY = '0';
      await signup(post({ email: 'one@example.com' }), env, T0);
      await signup(post({ email: 'two@example.com' }), env, T0 + 1);
      await signup(post({ email: 'three@example.com' }), env, T0 + 2);
      env.CONFIRM_EMAILS_PER_DAY = '90';
    }

    it('sends held confirmations oldest first and clears the flag', async () => {
      await holdThree();
      expect(await drainHeld(env, ORIGIN, T0 + MINUTE)).toBe(3);
      expect(mailCalls().map(([, init]) => JSON.parse(init.body as string).to[0])).toEqual([
        'one@example.com',
        'two@example.com',
        'three@example.com',
      ]);
      expect(held()).toEqual([]);
      expect(row('one@example.com').last_email_at).toBe(T0 + MINUTE);
      expect(sends()).toBe(3);
      const mail = JSON.parse(mailCalls()[0][1].body as string);
      expect(mail.html).toContain(`${ORIGIN}/api/confirm?token=${row('one@example.com').confirm_token}`);
    });

    it('sends only what the remaining budget allows, oldest first, and the rest waits', async () => {
      await holdThree();
      env.CONFIRM_EMAILS_PER_DAY = '2';
      expect(await drainHeld(env, ORIGIN, T0 + MINUTE)).toBe(2);
      expect(held()).toEqual(['three@example.com']);
      expect(await drainHeld(env, ORIGIN, T0 + 2 * MINUTE)).toBe(0);
      // The next UTC day there is budget again.
      expect(await drainHeld(env, ORIGIN, T0 + 86_400_000 + MINUTE)).toBe(1);
      expect(held()).toEqual([]);
    });

    it('never sends more than MAX_DRAIN_PER_RUN in one run', async () => {
      env.CONFIRM_EMAILS_PER_DAY = '0';
      for (let i = 0; i < MAX_DRAIN_PER_RUN + 3; i += 1) {
        await signup(post({ email: `u${i}@example.com` }), env, T0 + i);
      }
      env.CONFIRM_EMAILS_PER_DAY = '1000';
      expect(await drainHeld(env, ORIGIN, T0 + MINUTE)).toBe(MAX_DRAIN_PER_RUN);
      expect(held()).toHaveLength(3);
    });

    it('stops at the first failed send and leaves the rest held', async () => {
      await holdThree();
      fetchMock.mockResolvedValueOnce(new Response('down', { status: 500 }));
      expect(await drainHeld(env, ORIGIN, T0 + MINUTE)).toBe(0);
      expect(held()).toHaveLength(3);
      expect(sends()).toBe(0);
    });

    it('skips an address that unsubscribed or confirmed meanwhile', async () => {
      await holdThree();
      sqlite.exec("UPDATE waitlist SET status = 'unsubscribed' WHERE email = 'one@example.com'");
      sqlite.exec("UPDATE waitlist SET status = 'confirmed' WHERE email = 'two@example.com'");
      expect(await drainHeld(env, ORIGIN, T0 + MINUTE)).toBe(1);
      expect(held()).toEqual([]);
    });

    it('does nothing without a Resend key', async () => {
      await holdThree();
      delete env.RESEND_API_KEY;
      expect(await drainHeld(env, ORIGIN, T0 + MINUTE)).toBe(0);
      expect(held()).toHaveLength(3);
    });
  });
});

describe('confirm', () => {
  const get = (token?: string) => new Request(`${ORIGIN}/api/confirm${token === undefined ? '' : `?token=${token}`}`);

  it('marks a pending address confirmed and redirects to the friendly page', async () => {
    await signup(post({ email: 'c@example.com' }), env, T0);
    const { confirm_token } = row('c@example.com');
    const res = await confirm(get(confirm_token), env, T0 + MINUTE);
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe(`${ORIGIN}/waitlist/confirmed/`);
    expect(row('c@example.com')).toMatchObject({ status: 'confirmed', confirmed_at: T0 + MINUTE });
  });

  it('expires a link 7 days after the last confirmation email, and a fresh signup revives it', async () => {
    await signup(post({ email: 'late@example.com' }), env, T0);
    const { confirm_token } = row('late@example.com');
    const day = 86_400_000;
    const dead = await confirm(get(confirm_token), env, T0 + 7 * day + MINUTE);
    expect(dead.headers.get('location')).toBe(`${ORIGIN}/waitlist/invalid/`);
    expect(row('late@example.com').status).toBe('pending');

    await signup(post({ email: 'late@example.com' }), env, T0 + 8 * day);
    const ok = await confirm(get(confirm_token), env, T0 + 8 * day + MINUTE);
    expect(ok.headers.get('location')).toBe(`${ORIGIN}/waitlist/confirmed/`);
  });

  it('is idempotent and keeps the first confirmation time', async () => {
    await signup(post({ email: 'c@example.com' }), env, T0);
    const { confirm_token } = row('c@example.com');
    await confirm(get(confirm_token), env, T0 + MINUTE);
    const res = await confirm(get(confirm_token), env, T0 + 9 * MINUTE);
    expect(res.headers.get('location')).toBe(`${ORIGIN}/waitlist/confirmed/`);
    expect(row('c@example.com').confirmed_at).toBe(T0 + MINUTE);
  });

  it.each([undefined, '', 'unknown-token'])('sends token %j to the invalid-link page', async (token) => {
    const res = await confirm(get(token), env, T0);
    expect(res.headers.get('location')).toBe(`${ORIGIN}/waitlist/invalid/`);
  });

  it('does not revive an unsubscribed address through its old confirm link', async () => {
    await signup(post({ email: 'u@example.com' }), env, T0);
    const { confirm_token, unsubscribe_token } = row('u@example.com');
    await unsubscribe(new Request(`${ORIGIN}/api/unsubscribe?token=${unsubscribe_token}`), env, T0);
    const res = await confirm(get(confirm_token), env, T0);
    expect(res.headers.get('location')).toBe(`${ORIGIN}/waitlist/invalid/`);
    expect(row('u@example.com').status).toBe('unsubscribed');
  });
});

describe('unsubscribe', () => {
  it('GET from the email link unsubscribes and redirects to the friendly page', async () => {
    await signup(post({ email: 'g@example.com' }), env, T0);
    const { unsubscribe_token } = row('g@example.com');
    const res = await unsubscribe(new Request(`${ORIGIN}/api/unsubscribe?token=${unsubscribe_token}`), env, T0 + MINUTE);
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe(`${ORIGIN}/waitlist/unsubscribed/`);
    expect(row('g@example.com')).toMatchObject({ status: 'unsubscribed', unsubscribed_at: T0 + MINUTE });
  });

  it('one-click POST (RFC 8058) unsubscribes and answers 200', async () => {
    await signup(post({ email: 'p@example.com' }), env, T0);
    const { unsubscribe_token } = row('p@example.com');
    const res = await unsubscribe(
      new Request(`${ORIGIN}/api/unsubscribe?token=${unsubscribe_token}`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: 'List-Unsubscribe=One-Click',
      }),
      env,
      T0 + MINUTE,
    );
    expect(res.status).toBe(200);
    expect(row('p@example.com').status).toBe('unsubscribed');
  });

  it('keeps the first unsubscribe time when repeated', async () => {
    await signup(post({ email: 'r@example.com' }), env, T0);
    const { unsubscribe_token } = row('r@example.com');
    const link = () => new Request(`${ORIGIN}/api/unsubscribe?token=${unsubscribe_token}`);
    await unsubscribe(link(), env, T0 + MINUTE);
    await unsubscribe(link(), env, T0 + 5 * MINUTE);
    expect(row('r@example.com').unsubscribed_at).toBe(T0 + MINUTE);
  });

  it('an unknown token goes to the invalid page on GET and is a 404 on POST', async () => {
    const get = await unsubscribe(new Request(`${ORIGIN}/api/unsubscribe?token=nope`), env, T0);
    expect(get.headers.get('location')).toBe(`${ORIGIN}/waitlist/invalid/`);
    const oneClick = await unsubscribe(new Request(`${ORIGIN}/api/unsubscribe?token=nope`, { method: 'POST' }), env, T0);
    expect(oneClick.status).toBe(404);
  });
});

describe('Resend contact sync', () => {
  const confirmLink = (token: string) => new Request(`${ORIGIN}/api/confirm?token=${token}`);
  const unsubLink = (token: string) => new Request(`${ORIGIN}/api/unsubscribe?token=${token}`);

  async function pendingRow(email = 's@example.com'): Promise<Row> {
    await signup(post({ email }), env, T0);
    fetchMock.mockClear();
    return row(email);
  }

  it('on confirm creates the contact, adds it to the segment and marks the row synced', async () => {
    const r = await pendingRow();
    await confirm(confirmLink(r.confirm_token), env, T0 + MINUTE);
    expect(contactCalls()).toEqual(['POST ', `POST /s@example.com/segments/${SEGMENT}`]);
    expect(JSON.parse(calls()[0][1].body as string)).toEqual({ email: 's@example.com', unsubscribed: false });
    expect(row('s@example.com')).toMatchObject({ status: 'confirmed', resend_synced: 1 });
  });

  it('re-subscribes a contact that already exists in Resend', async () => {
    const r = await pendingRow();
    fetchMock.mockResolvedValueOnce(new Response('exists', { status: 409 }));
    await confirm(confirmLink(r.confirm_token), env, T0 + MINUTE);
    expect(contactCalls()).toEqual(['POST ', 'PATCH /s@example.com', `POST /s@example.com/segments/${SEGMENT}`]);
    expect(row('s@example.com').resend_synced).toBe(1);
  });

  it('a Resend failure on confirm still confirms for the visitor and leaves the row unsynced', async () => {
    const r = await pendingRow();
    fetchMock.mockResolvedValue(new Response('down', { status: 500 }));
    const res = await confirm(confirmLink(r.confirm_token), env, T0 + MINUTE);
    expect(res.headers.get('location')).toBe(`${ORIGIN}/waitlist/confirmed/`);
    expect(row('s@example.com')).toMatchObject({ status: 'confirmed', resend_synced: 0 });
    expect(console.error).toHaveBeenCalled();
  });

  it('a network error on confirm is swallowed the same way', async () => {
    const r = await pendingRow();
    fetchMock.mockRejectedValue(new Error('offline'));
    const res = await confirm(confirmLink(r.confirm_token), env, T0 + MINUTE);
    expect(res.status).toBe(303);
    expect(row('s@example.com').resend_synced).toBe(0);
  });

  it('a repeat click on the confirm link retries a sync that failed earlier, and only then', async () => {
    const r = await pendingRow();
    fetchMock.mockResolvedValue(new Response('down', { status: 500 }));
    await confirm(confirmLink(r.confirm_token), env, T0 + MINUTE);
    fetchMock.mockReset().mockResolvedValue(new Response('{}', { status: 200 }));
    await confirm(confirmLink(r.confirm_token), env, T0 + 2 * MINUTE);
    expect(row('s@example.com').resend_synced).toBe(1);
    fetchMock.mockClear();
    await confirm(confirmLink(r.confirm_token), env, T0 + 3 * MINUTE);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('skips the contact sync without a segment id, leaving the row unsynced', async () => {
    delete env.RESEND_SEGMENT_ID;
    const r = await pendingRow();
    await confirm(confirmLink(r.confirm_token), env, T0 + MINUTE);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(row('s@example.com')).toMatchObject({ status: 'confirmed', resend_synced: 0 });
  });

  it('on unsubscribe (link and one-click) marks the Resend contact unsubscribed', async () => {
    const r = await pendingRow();
    await unsubscribe(unsubLink(r.unsubscribe_token), env, T0 + MINUTE);
    expect(contactCalls()).toEqual(['PATCH /s@example.com']);
    expect(JSON.parse(calls()[0][1].body as string)).toEqual({ unsubscribed: true });
    expect(row('s@example.com').resend_synced).toBe(1);

    const other = await pendingRow('o@example.com');
    await unsubscribe(new Request(unsubLink(other.unsubscribe_token), { method: 'POST' }), env, T0 + MINUTE);
    expect(contactCalls()).toEqual(['PATCH /o@example.com']);
  });

  it('treats "no such contact" (never confirmed) as already unsubscribed', async () => {
    const r = await pendingRow();
    fetchMock.mockResolvedValue(new Response('missing', { status: 404 }));
    await unsubscribe(unsubLink(r.unsubscribe_token), env, T0 + MINUTE);
    expect(row('s@example.com')).toMatchObject({ status: 'unsubscribed', resend_synced: 1 });
  });

  it('a Resend failure on unsubscribe still unsubscribes in D1 and flags the row for backfill', async () => {
    const r = await pendingRow();
    fetchMock.mockResolvedValue(new Response('down', { status: 500 }));
    const res = await unsubscribe(unsubLink(r.unsubscribe_token), env, T0 + MINUTE);
    expect(res.status).toBe(303);
    expect(row('s@example.com')).toMatchObject({ status: 'unsubscribed', resend_synced: 0 });
  });

  it('re-signup after an unsubscribe resets the sync flag until the new confirmation', async () => {
    const r = await pendingRow();
    await unsubscribe(unsubLink(r.unsubscribe_token), env, T0 + MINUTE);
    await signup(post({ email: 's@example.com' }), env, T0 + 2 * MINUTE);
    expect(row('s@example.com')).toMatchObject({ status: 'pending', resend_synced: 0 });
  });
});

describe('listUnsubscribedContacts', () => {
  const config = { RESEND_API_KEY: 'k', RESEND_SEGMENT_ID: SEGMENT };

  it('pages through the segment and returns only unsubscribed, lowercased addresses', async () => {
    fetchMock
      .mockResolvedValueOnce(
        Response.json({
          data: [
            { id: 'c1', email: 'A@example.com', unsubscribed: true },
            { id: 'c2', email: 'b@example.com', unsubscribed: false },
          ],
          has_more: true,
        }),
      )
      .mockResolvedValueOnce(
        Response.json({ data: [{ id: 'c3', email: 'c@example.com', unsubscribed: true }], has_more: false }),
      );
    expect(await listUnsubscribedContacts(config)).toEqual(['a@example.com', 'c@example.com']);
    expect(calls()[0][0]).toContain(`segment_id=${SEGMENT}`);
    expect(calls()[1][0]).toContain('after=c2');
  });

  it('throws on an API error so the script fails loudly', async () => {
    fetchMock.mockResolvedValueOnce(new Response('no', { status: 401 }));
    await expect(listUnsubscribedContacts(config)).rejects.toThrow('401');
  });
});
