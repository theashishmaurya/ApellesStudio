#!/usr/bin/env node
// scopes.check.mjs — guard against the standalone port in scopes.mjs drifting
// from the engine ground truth in engine/src/utils/scopes.ts (D-021).
//
// Not a numeric equivalence test (the engine module is TS + browser canvas and
// can't run here) — a constant-drift tripwire. It asserts the load-bearing
// constants my port copies still appear verbatim in scopes.ts. If this fails,
// re-read scopes.ts, update eval/lib/scopes.mjs, and re-run
// `node eval/score.mjs --baseline`.
//
//   node eval/lib/scopes.check.mjs   (exit 0 ok / 1 drift / 0 skipped if absent)

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(DIR, '../../engine/src/utils/scopes.ts');

if (!fs.existsSync(SRC)) {
  console.log('scopes.ts not present (thin clone) — skipping drift check.');
  process.exit(0);
}

const src = fs.readFileSync(SRC, 'utf8').replace(/\s+/g, ' ');
const MUST_CONTAIN = [
  '0.2126 * r + 0.7152 * g + 0.0722 * b',        // REC709 weights
  'Math.max(1, Math.ceil(Math.max(w, h) / target))', // stride
  'target = 512',                                  // downsample target
  'l < 64 ? z.sh : l <= 191 ? z.mi : z.hi',        // zone split
  'if (li <= 1) lumaClipLo++',                     // luma low clip
  'if (li >= 254) lumaClipHi++',                   // luma high clip
  'if (r === 0) rClipLo++; else if (r === 255) rClipHi++', // channel clip
  'blackPoint: pct(1)',
  'whitePoint: pct(99)',
  'if (s > 0.05)',                                 // hue-hist saturation gate
  'mids.meanRGB[0] - mids.meanRGB[2]',             // cast.warmCool
  'mids.meanRGB[1] - (mids.meanRGB[0] + mids.meanRGB[2]) / 2', // cast.greenMagenta
  '((ref.zones.mids.luma - subj.zones.mids.luma) / 64) * 0.5', // computeGap exposure
];

const missing = MUST_CONTAIN.filter((s) => !src.includes(s.replace(/\s+/g, ' ')));
if (missing.length) {
  console.error('DRIFT: scopes.ts no longer contains:\n  - ' + missing.join('\n  - '));
  console.error('\nUpdate eval/lib/scopes.mjs to match, then: node eval/score.mjs --baseline');
  process.exit(1);
}
console.log(`scopes.mjs port: ${MUST_CONTAIN.length}/${MUST_CONTAIN.length} constants match scopes.ts — no drift.`);
