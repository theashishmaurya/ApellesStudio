/**
 * website/scripts/export-waitlist.mjs — CSV export of the waitlist (D-426).
 *
 * What it is: reads the production `apelles-waitlist` D1 database through
 * `wrangler d1 execute --remote --json` (wrangler's own login; no credentials
 * here) and writes CSV.
 * What it does NOT do: modify anything, or include the confirm/unsubscribe
 * tokens (they are bearer secrets for one address each).
 *
 *   npm run export:waitlist                    # confirmed addresses, to stdout
 *   npm run export:waitlist -- --status all    # every row
 *   npm run export:waitlist -- --out list.csv  # to a file
 *   npm run export:waitlist -- --local         # the local dev database
 */
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';

const DATABASE = 'apelles-waitlist';
const STATUSES = ['confirmed', 'pending', 'unsubscribed', 'all'];
const COLUMNS = ['email', 'role', 'source', 'status', 'created_at', 'confirmed_at', 'unsubscribed_at'];
const TIME_COLUMNS = new Set(['created_at', 'confirmed_at', 'unsubscribed_at']);

const { values } = parseArgs({
  options: {
    status: { type: 'string', default: 'confirmed' },
    out: { type: 'string' },
    local: { type: 'boolean', default: false },
  },
});

if (!STATUSES.includes(values.status)) {
  console.error(`--status must be one of: ${STATUSES.join(', ')}`);
  process.exit(2);
}

// `values.status` is checked against the allow-list above, so interpolating it is safe.
const where = values.status === 'all' ? '' : `WHERE status = '${values.status}'`;
const sql = `SELECT ${COLUMNS.join(', ')} FROM waitlist ${where} ORDER BY created_at`;

const raw = execFileSync(
  'npx',
  ['wrangler', 'd1', 'execute', DATABASE, values.local ? '--local' : '--remote', '--json', '--command', sql],
  { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
);
const rows = JSON.parse(raw).flatMap((statement) => statement.results);

function cell(column, value) {
  if (value === null || value === undefined) return '';
  const text = TIME_COLUMNS.has(column) ? new Date(value).toISOString() : String(value);
  return /[",\n\r]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

const csv = [COLUMNS.join(','), ...rows.map((row) => COLUMNS.map((c) => cell(c, row[c])).join(','))].join('\n') + '\n';

if (values.out) {
  writeFileSync(values.out, csv);
  console.error(`wrote ${rows.length} rows to ${values.out}`);
} else {
  process.stdout.write(csv);
}
