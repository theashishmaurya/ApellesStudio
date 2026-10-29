/**
 * waitlist.test.ts — the waitlist handlers (D-426), end to end over a real
 * SQLite database built from the real migration (node:sqlite stands in for D1,
 * which is SQLite) and a mocked `fetch` standing in for Resend.
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
import { ROLES } from '../src/data/beta.ts';

const ORIGIN = 'https://apelles.studio';
const MIGRATION = readFileSync(new URL('../migrations/0001_waitlist.sql', import.meta.url), 'utf8');
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
}

function d1Over(sqlite: DatabaseSync): Db {
  const statement = (sql: string, values: SqlValue[] = []): DbStatement => ({
    bind: (...v: unknown[]) => statement(sql, v as SqlValue[]),
    first: async <T>() => (sqlite.prepare(sql).get(...values) as T | undefined) ?? null,
    run: async () => sqlite.prepare(sql).run(...values),
  });
  return { prepare: (sql) => statement(sql) };
}

let sqlite: DatabaseSync;
let env: WaitlistEnv;
let fetchMock: ReturnType<typeof vi.fn>;

const rows = () => sqlite.prepare('SELECT * FROM waitlist ORDER BY id').all() as unknown as Row[];
const row = (email: string) => rows().find((r) => r.email === email) as Row;

function post(body: unknown, init: { type?: string; raw?: string } = {}): Request {
  const type = init.type ?? 'application/json';
  return new Request(`${ORIGIN}/api/waitlist`, {
    method: 'POST',
    headers: { 'content-type': type },
    body: init.raw ?? JSON.stringify(body),
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
  sqlite.exec(MIGRATION);
  env = {
    DB: d1Over(sqlite),
    RESEND_API_KEY: 'test-key',
    RESEND_SEGMENT_ID: SEGMENT,
    MAIL_FROM: 'Apelles <hello@apelles.studio>',
  };
  fetchMock = vi.fn(async () => new Response('{"id":"x"}', { status: 200 }));
  vi.stubGlobal('fetch', fetchMock);
  vi.spyOn(console, 'warn').mockImplementation(() => {});
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
    expect(mail.from).toBe('Apelles <hello@apelles.studio>');
    expect(mail.to).toEqual(['someone@example.com']);
    expect(mail.subject).toBe(CONFIRM_SUBJECT);
    expect(mail.html).toContain(`${ORIGIN}/api/confirm?token=${r.confirm_token}`);
    expect(mail.text).toContain(`${ORIGIN}/api/confirm?token=${r.confirm_token}`);
    expect(mail.headers['List-Unsubscribe']).toBe(`<${ORIGIN}/api/unsubscribe?token=${r.unsubscribe_token}>`);
    expect(mail.headers['List-Unsubscribe-Post']).toBe('List-Unsubscribe=One-Click');
  });

  it('accepts a classic form post too', async () => {
    const res = await signup(
      post(null, { type: 'application/x-www-form-urlencoded', raw: 'email=form%40example.com&source=beta' }),
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

  it('reports a failed send as an error and leaves the throttle open so the visitor can retry', async () => {
    fetchMock.mockResolvedValueOnce(new Response('nope', { status: 500 }));
    const res = await signup(post({ email: 'retry@example.com' }), env, T0);
    expect(res.status).toBe(502);
    expect(row('retry@example.com').last_email_at).toBeNull();

    const retry = await signup(post({ email: 'retry@example.com' }), env, T0 + 1000);
    expect(retry.status).toBe(200);
    expect(mailCalls()).toHaveLength(2);
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
    ]);
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
