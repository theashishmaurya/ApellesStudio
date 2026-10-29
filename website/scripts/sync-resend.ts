/**
 * website/scripts/sync-resend.ts — reconciles the waitlist (D1, the master)
 * with Resend's contact list (D-426).
 *
 *   RESEND_API_KEY=... npm run sync:resend -- unsubscribes [--local]
 *   RESEND_API_KEY=... npm run sync:resend -- backfill [--local]
 *
 * `unsubscribes` pulls the "Apelles Beta" segment's unsubscribed contacts from
 * Resend and marks the matching D1 rows unsubscribed. Run it before every
 * broadcast: a recipient who used the unsubscribe link in a broadcast footer
 * told Resend, not us, and there is deliberately no webhook (D-426).
 *
 * `backfill` retries the rows whose Resend sync failed at confirm/unsubscribe
 * time (`resend_synced = 0`), and also pushes rows confirmed before the Resend
 * sync existed.
 *
 * What it does NOT do: print the key, delete anything, or touch pending rows.
 * Runs on Node 22.18+ (native TypeScript); the key comes from the environment,
 * D1 is reached through wrangler's own login, `--remote` unless `--local`.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { isValidEmail } from '../src/data/beta.ts';
import {
  addConfirmedContact,
  listUnsubscribedContacts,
  unsubscribeContact,
  type ResendConfig,
} from '../functions/_lib/resend-contacts.ts';

const DATABASE = 'apelles-waitlist';
/** Resend allows a few requests a second; one row costs up to three. */
const PAUSE_BETWEEN_ROWS_MS = 1000;

interface Row {
  id: number;
  email: string;
  status: 'confirmed' | 'unsubscribed';
}

const { positionals, values } = parseArgs({ allowPositionals: true, options: { local: { type: 'boolean', default: false } } });
const command = positionals[0];
if (command !== 'unsubscribes' && command !== 'backfill') {
  console.error('usage: sync-resend.ts <unsubscribes|backfill> [--local]');
  process.exit(2);
}

const apiKey = process.env.RESEND_API_KEY;
if (!apiKey) {
  console.error('RESEND_API_KEY is not set in the environment');
  process.exit(2);
}
const segmentId =
  process.env.RESEND_SEGMENT_ID ??
  /^RESEND_SEGMENT_ID\s*=\s*"([^"]+)"/m.exec(readFileSync(new URL('../wrangler.toml', import.meta.url), 'utf8'))?.[1];
const config: ResendConfig = { RESEND_API_KEY: apiKey, RESEND_SEGMENT_ID: segmentId };

const target = values.local ? '--local' : '--remote';

function d1(args: string[]): { results: Record<string, unknown>[] }[] {
  const out = execFileSync('npx', ['wrangler', 'd1', 'execute', DATABASE, target, '--json', ...args], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  return JSON.parse(out) as { results: Record<string, unknown>[] }[];
}

function select(sql: string): Row[] {
  return d1(['--command', sql]).flatMap((s) => s.results) as unknown as Row[];
}

function write(sql: string): void {
  const dir = mkdtempSync(join(tmpdir(), 'sync-resend-'));
  const file = join(dir, 'update.sql');
  try {
    writeFileSync(file, sql);
    d1(['--file', file]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function unsubscribes(): Promise<void> {
  const fromResend = new Set((await listUnsubscribedContacts(config)).filter(isValidEmail));
  const live = select("SELECT id, email, status FROM waitlist WHERE status IN ('pending', 'confirmed')");
  const ids = live.filter((r) => fromResend.has(r.email)).map((r) => r.id);
  if (ids.length > 0) {
    write(
      `UPDATE waitlist SET status = 'unsubscribed', unsubscribed_at = ${Date.now()}, resend_synced = 1 WHERE id IN (${ids.join(',')});`,
    );
  }
  console.error(`${fromResend.size} unsubscribed in Resend; marked ${ids.length} more in D1`);
}

async function backfill(): Promise<void> {
  const rows = select(
    "SELECT id, email, status FROM waitlist WHERE resend_synced = 0 AND status IN ('confirmed', 'unsubscribed') ORDER BY id",
  );
  const done: number[] = [];
  for (const row of rows) {
    const ok =
      row.status === 'confirmed' ? await addConfirmedContact(config, row.email) : await unsubscribeContact(config, row.email);
    if (ok) done.push(row.id);
    await sleep(PAUSE_BETWEEN_ROWS_MS);
  }
  if (done.length > 0) write(`UPDATE waitlist SET resend_synced = 1 WHERE id IN (${done.join(',')});`);
  console.error(`${done.length} of ${rows.length} unsynced rows pushed to Resend`);
}

await (command === 'unsubscribes' ? unsubscribes() : backfill());
