// Chroma — pure helpers for the agent activity feed (D-032).
//
// `diffAdjustments` — a structural before/after diff of the RapidRAW grade doc.
// `summarizeActivity` — a per-op human-readable one-liner.
//
// No React, no store, no side effects — unit-testable in isolation. See
// docs/notes/agent-activity-feed.md.
import { FieldDiff } from '../store/useAgentStore';

/** matte blobs — never dump these into a diff row */
const HEAVY_KEYS = new Set(['maskDataBase64', 'mask_data_base64']);
/** noisy / non-grade keys to skip entirely */
const SKIP_KEYS = new Set(['sectionVisibility', 'rating']);

const isPlainObj = (x: any) => x != null && typeof x === 'object' && !Array.isArray(x);

function round(v: number): number {
  return Math.abs(v) >= 100 ? Math.round(v) : Math.round(v * 1000) / 1000;
}

function shortVal(v: any): any {
  if (v == null) return v;
  if (typeof v === 'number') return round(v);
  if (typeof v === 'string') return v.length > 40 ? `${v.slice(0, 37)}…` : v;
  if (Array.isArray(v)) return `[${v.length}]`;
  if (isPlainObj(v)) {
    const keys = Object.keys(v);
    return `{${keys.slice(0, 4).join(',')}${keys.length > 4 ? ',…' : ''}}`;
  }
  return v;
}

function heavyRow(path: string, a: any, b: any): FieldDiff | null {
  const pa = a ? String(a).length : 0;
  const pb = b ? String(b).length : 0;
  if (!!a === !!b && pa === pb) return null;
  return { path, before: a ? '<matte>' : null, after: b ? '<matte>' : null };
}

function diffObject(a: any, b: any, base: string, out: FieldDiff[]) {
  const keys = new Set<string>([...Object.keys(a || {}), ...Object.keys(b || {})]);
  for (const k of keys) {
    if (SKIP_KEYS.has(k)) continue;
    const path = base ? `${base}.${k}` : k;
    const av = a?.[k];
    const bv = b?.[k];
    if (av === bv) continue;

    if (HEAVY_KEYS.has(k)) {
      const row = heavyRow(path, av, bv);
      if (row) out.push(row);
      continue;
    }
    if (k === 'masks' || k === 'aiPatches') {
      diffContainers(path, av || [], bv || [], out);
      continue;
    }
    if (isPlainObj(av) && isPlainObj(bv)) {
      diffObject(av, bv, path, out);
      continue;
    }
    if (Array.isArray(av) || Array.isArray(bv)) {
      if (JSON.stringify(av ?? null) !== JSON.stringify(bv ?? null)) {
        out.push({ path, before: shortVal(av), after: shortVal(bv) });
      }
      continue;
    }
    out.push({ path, before: shortVal(av), after: shortVal(bv) });
  }
}

/** mask / aiPatch containers — matched by `id`, not index. */
function diffContainers(base: string, a: any[], b: any[], out: FieldDiff[]) {
  const label = (c: any) => (c?.name ? `${base} "${c.name}"` : `${base}[${c?.id?.slice?.(0, 6) ?? '?'}]`);
  const bIds = new Set(b.map((c) => c?.id));
  const aIds = new Set(a.map((c) => c?.id));

  for (const c of a) {
    if (!bIds.has(c?.id)) out.push({ path: label(c), before: 'present', after: 'removed' });
  }
  for (const c of b) {
    if (!aIds.has(c?.id)) {
      out.push({ path: label(c), before: 'absent', after: 'added' });
      continue;
    }
    const prev = a.find((x) => x?.id === c?.id);
    if (prev === c) continue;
    // container-level fields (visible, invert, opacity, adjustments{})
    const { subMasks: pSub, ...pRest } = prev || {};
    const { subMasks: cSub, ...cRest } = c || {};
    diffObject(pRest, cRest, label(c), out);
    // sub-masks — matched by id too
    diffSubMasks(label(c), pSub || [], cSub || [], out);
  }
}

function diffSubMasks(base: string, a: any[], b: any[], out: FieldDiff[]) {
  const bIds = new Set(b.map((s) => s?.id));
  const aIds = new Set(a.map((s) => s?.id));
  for (const s of a) {
    if (!bIds.has(s?.id)) out.push({ path: `${base}/sub[${s?.type ?? '?'}]`, before: 'present', after: 'removed' });
  }
  for (const s of b) {
    if (!aIds.has(s?.id)) {
      out.push({ path: `${base}/sub[${s?.type ?? '?'}]`, before: 'absent', after: 'added' });
      continue;
    }
    const prev = a.find((x) => x?.id === s?.id);
    if (prev !== s) diffObject(prev, s, `${base}/sub[${s?.type ?? '?'}]`, out);
  }
}

/**
 * Structural before/after diff of the grade doc. Returns one row per changed
 * leaf. Matte blobs collapse to `<matte>`; mask/aiPatch containers match by id.
 */
export function diffAdjustments(before: any, after: any): FieldDiff[] {
  const out: FieldDiff[] = [];
  diffObject(before || {}, after || {}, '', out);
  return out;
}

// --------------------------------------------------------------------------- //
// summaries
// --------------------------------------------------------------------------- //
const ABBREV: Record<string, string> = {
  temperature: 'temp',
  saturation: 'sat',
  highlights: 'high',
  shadows: 'shad',
  contrast: 'contr',
  vignetteAmount: 'vignette',
};

function fmtNum(v: number): string {
  const r = round(v);
  return (r > 0 ? '+' : '') + r;
}

/** "exposure +0.35, temp −8" from a {knob: value} patch */
function knobList(patch: Record<string, any> | undefined, max = 4): string {
  if (!isPlainObj(patch)) return '';
  const parts = Object.entries(patch ?? {})
    .filter(([, v]) => typeof v === 'number' && Number.isFinite(v) && v !== 0)
    .map(([k, v]) => `${ABBREV[k] ?? k} ${fmtNum(v as number)}`);
  if (parts.length === 0) return '';
  return parts.slice(0, max).join(', ') + (parts.length > max ? `, +${parts.length - max} more` : '');
}

/** knob list rebuilt from diff rows whose leaf is a top-level numeric knob */
function knobListFromDiff(diff: FieldDiff[], max = 4): string {
  const parts = diff
    .filter((d) => !d.path.includes('.') && !d.path.includes(' ') && typeof d.after === 'number')
    .map((d) => `${ABBREV[d.path] ?? d.path} ${fmtNum(d.after as number)}`);
  if (parts.length) return parts.slice(0, max).join(', ') + (parts.length > max ? `, +${parts.length - max} more` : '');
  return '';
}

const basename = (p: any) =>
  typeof p === 'string' ? p.split(/[\\/]/).pop() || p : '';
const shortId = (id: any) => (typeof id === 'string' ? id.slice(0, 6) : '?');

type Fmt = (a: any, r: any, diff: FieldDiff[]) => string;

const FORMATTERS: Record<string, Fmt> = {
  set_primary: (a, r) => `primary: ${knobList(r?.applied ?? a?.patch ?? a) || 'adjusted'}`,
  set_mask_adjust: (a, r) =>
    `mask ${shortId(a?.mask_id ?? a?.maskId)}: ${knobList(r?.applied ?? a?.patch) || 'adjusted'}`,
  set_color_grade: (a) => {
    const p = a?.patch ?? a ?? {};
    const zones = ['shadows', 'midtones', 'highlights', 'global'].filter((z) => isPlainObj(p[z]));
    const bits = zones.map((z) => `${z} ${knobList(p[z], 2) || 'moved'}`);
    if (typeof p.balance === 'number') bits.push(`balance ${fmtNum(p.balance)}`);
    if (typeof p.blending === 'number') bits.push(`blending ${fmtNum(p.blending)}`);
    return `color grade: ${bits.join('; ') || 'adjusted'}`;
  },
  set_curve: (a) => `curve (${a?.channel ?? 'luma'}): ${(a?.points ?? []).length} points`,
  add_mask: (a, r) => `added ${r?.type ?? a?.type ?? 'radial'} mask`,
  add_subject_mask: (a, r) => `added subject mask (${r?.mode ?? a?.mode ?? 'additive'})`,
  add_component: (a) =>
    `added ${a?.mode ?? 'subtractive'} ${a?.type ?? '?'} component to mask ${shortId(a?.mask_id ?? a?.maskId)}`,
  set_submask_mode: (a) => `component ${shortId(a?.sub_mask_id ?? a?.subMaskId)} → ${a?.mode ?? '?'}`,
  apply_haze: (a) => `depth haze (amount ${a?.amount ?? 1}${a?.tracked ? ', tracked' : ''})`,
  track_subject: (a) => `tracked subject across clip (${a?.mode ?? 'fast'})`,
  depth_track: () => 'started depth track over clip (Video Depth Anything)',
  invert_mask: () => 'inverted mask',
  delete_mask: (a) => `deleted mask ${shortId(a?.mask_id ?? a?.maskId)}`,
  match_reference: (_a, r) =>
    `match to reference: ${r?.iterations ?? 0} iters, gap ${r?.gap_before ?? '?'}→${r?.gap_after ?? '?'}`,
  load_grade: (a) => `loaded grade${a?.path ? ` ${basename(a.path)}` : '.json'}`,
};

/** one-liner for a feed entry. Cosmetic — the diff is the source of truth. */
export function summarizeActivity(op: string, args: any, result: any, diff: FieldDiff[]): string {
  const f = FORMATTERS[op];
  if (f) {
    try {
      const s = f(args, result, diff);
      if (s) return s;
    } catch {
      /* fall through */
    }
  }
  const kl = knobListFromDiff(diff);
  if (kl) return `${op}: ${kl}`;
  return `${op}: ${diff.length} field${diff.length === 1 ? '' : 's'} changed`;
}
