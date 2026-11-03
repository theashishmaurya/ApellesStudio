// @apelles/editor — **the TypeScript half of the real-project export parity
// check (B-380): the filter path vs the compositor path on copies of real
// projects.**
//
// What it is: a harness, not a unit test. It is skipped unless
// `APELLES_PARITY_STAGE` is set, and it is driven by the Rust half,
// `chroma::edit_render::export_parity_real::measure_real_project_parity`,
// which runs it twice per project copy:
//
// - `plan` — reads the copy's `project.json`, cuts short ranges out of its
//   timelines around every effect it carries (text, rounded PIP, crop,
//   keyframes, fades, captions, a grade, mixed frame rates and sizes), adds the
//   whole of one timeline, and adds a COVERAGE timeline built from the copy's
//   own media for the effects the owner's projects do not use (transitions,
//   adjustment clips, a speed ramp, a dynamic zoom, highlights, graded clips
//   under a transform / crop / mask, and the export-time Clip exceptions).
//   It writes the cases and what the Rust half must measure before the argvs
//   can be compiled: the animated captions' words, and the coverage grades.
// - `compile` — compiles each case with the REAL `compileEditorExportArgs`,
//   once per renderer, with the backend's answers (fonts, composition size,
//   baked grade LUTs, caption metrics) served from the facts file the Rust half
//   wrote, and writes both argvs.
//
// What it does NOT do: run ffmpeg or compare pictures — the Rust half does.
// The media pool comes from the copy's own `project.json`, so the compiler sees
// exactly the probes the app would.
import { readFileSync, writeFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { useMediaPoolStore, type MediaItem } from '@apelles/bridge';

import { sliceTimelineWindow } from './clipper/timelineSourceSlice';
import { applyDynamicZoom, dynamicZoomSpan } from './dynamicZoom';
import { compileEditorExportArgs, warmAnimatedCaptionMetrics } from './editorExport';
import { warmCompositionSize } from './compositionSize';
import { warmGradeLuts } from './gradeLuts';
import { loadTextFonts } from './textFonts';
import { endFrame, timelineFps, type Clip, type Timeline, type Track } from './timeline';

const STAGE = process.env.APELLES_PARITY_STAGE ?? '';

interface Facts {
  projectJson: string;
  fonts: unknown[];
  /** Keyed by SOURCE timeline id (a case's own id maps back through `caseSource`). */
  compSizes: Record<string, { compWidth: number; compHeight: number }>;
  gradeLuts?: { luts: Record<string, string>; warnings: string[] };
  /** `font|px|word` → advance. */
  captionWords?: Record<string, number>;
}

/** One export to compare. `timeline.id` is the case's own id. */
interface PlannedCase {
  label: string;
  effects: string[];
  sourceTimelineId: string;
  timeline: Timeline;
  width: number;
  height: number;
  exportArgs: Record<string, unknown>;
}

interface Plan {
  cases: PlannedCase[];
  /** What the Rust half writes into the copy's `grades/` before baking. */
  coverageGrades: Record<string, 'primary' | 'curves_lut' | 'mask'>;
  /** Animated-caption words to measure: `{font, fontPx, words}`. */
  captionRequests: Array<{ font: string; fontPx: number; words: string[] }>;
}

const facts: Facts | null = STAGE ? (JSON.parse(readFileSync(process.env.APELLES_PARITY_FACTS ?? '', 'utf8')) as Facts) : null;
const caseSource = new Map<string, string>();
const recordedCaptionRequests: Plan['captionRequests'] = [];

vi.mock('@tauri-apps/api/core', () => ({
  invoke: async (cmd: string, args?: Record<string, unknown>) => {
    if (!facts) throw new Error('no facts');
    switch (cmd) {
      case 'chroma_text_fonts':
        return facts.fonts;
      case 'chroma_timeline_composition_size': {
        const id = String(args?.timelineId ?? '');
        const size = facts.compSizes[id] ?? facts.compSizes[caseSource.get(id) ?? ''];
        if (!size) throw new Error(`no composition size for ${id}`);
        return { ...size, naturalWidth: 1, naturalHeight: 1 };
      }
      case 'chroma_timeline_grade_luts': {
        const ids = new Set((args?.clipIds as string[]) ?? []);
        const all = facts.gradeLuts ?? { luts: {}, warnings: [] };
        return { luts: Object.fromEntries(Object.entries(all.luts).filter(([k]) => ids.has(k))), warnings: all.warnings };
      }
      case 'chroma_measure_caption_words': {
        const font = String(args?.font);
        const fontPx = Number(args?.fontPx);
        const words = (args?.words as string[]) ?? [];
        recordedCaptionRequests.push({ font, fontPx, words });
        return words.map((w) => facts.captionWords?.[`${font}|${fontPx}|${w}`] ?? Number.NaN);
      }
      default:
        throw new Error(`the parity harness does not serve ${cmd}`);
    }
  },
}));

/** Export size: the composition's shape with its short edge at 1080. */
function size1080(comp: { compWidth: number; compHeight: number }): { width: number; height: number } {
  const k = 1080 / Math.min(comp.compWidth, comp.compHeight);
  const even = (v: number) => Math.max(2, Math.round((v * k) / 2) * 2);
  return { width: even(comp.compWidth), height: even(comp.compHeight) };
}

/** The frames `[start, end)` of `tl` as a timeline of its own, starting at 0:
 *  picture and audio through the Clipper's own slicer (the reducer's split),
 *  captions that start inside the window shifted and clamped to it. */
function sliceCase(tl: Timeline, start: number, end: number, id: string): Timeline {
  const fps = timelineFps(tl);
  const sliced = sliceTimelineWindow(tl, start, end, fps);
  const tracks: Track[] = tl.tracks.map((t, i) => {
    if (t.kind === 'subtitle') {
      return {
        ...t,
        clips: t.clips
          .filter((c) => c.start_frame >= start && c.start_frame < end)
          .map((c) => {
            const at = c.start_frame - start;
            return { ...c, start_frame: at, duration: Math.min(c.duration, end - start - at), source_len: Math.min(c.source_len, end - start - at) };
          }),
      };
    }
    return sliced.find((s) => s.sourceIndex === i)?.track ?? { ...t, clips: [] };
  });
  return { ...tl, id, name: `${tl.name} [${start}-${end})`, tracks, markers: [] };
}

const isPicture = (c: Clip) => !c.text && !c.adjustment && !c.caption && !!c.source_path;

/** The effects present in `tl` — what each case's numbers are reported under. */
function effectsOf(tl: Timeline, graded: Set<string>, pool: MediaItem[]): string[] {
  const fx = new Set<string>();
  const fpsSet = new Set<number>();
  const sizes = new Set<string>();
  for (const t of tl.tracks) {
    if (t.kind === 'subtitle' && t.clips.length) fx.add('captions');
    for (const tr of t.transitions ?? []) fx.add(`transition:${tr.kind}`);
    if (t.kind !== 'video') continue;
    for (const c of t.clips) {
      if (c.text) fx.add('text');
      if (c.adjustment) fx.add('adjustment');
      if (c.highlights?.length) fx.add('highlights');
      if ((c.corner_radius ?? 0) > 0) fx.add('rounded');
      if (c.crop_left || c.crop_right || c.crop_top || c.crop_bottom) fx.add('crop');
      if (c.box_width != null || (c.scale ?? 1) !== 1 || c.position_x || c.position_y) fx.add('transform');
      if (c.chroma_keyframes?.length) fx.add('keyframes');
      if ((c.fade_in_frames ?? 0) > 0 || (c.fade_out_frames ?? 0) > 0) fx.add('fades');
      if (c.speed_points?.length) fx.add('speed');
      if (graded.has(c.id)) fx.add('grade');
      if (isPicture(c)) {
        const m = pool.find((p) => p.id === c.media_id || p.sourcePath === c.source_path);
        const v = m?.video ?? m?.image;
        if (m?.video?.fps) fpsSet.add(Math.round(m.video.fps * 100) / 100);
        if (v) sizes.add(`${v.width}x${v.height}`);
      }
    }
  }
  if (fpsSet.size > 1 || [...fpsSet].some((f) => Math.abs(f - timelineFps(tl)) > 0.01)) fx.add('mixed-fps');
  if (sizes.size > 1) fx.add('mixed-size');
  return [...fx].sort();
}

/** Short windows around the first clip carrying each effect, in timeline frames. */
function windowsFor(tl: Timeline, graded: Set<string>, seconds: number): Array<{ start: number; end: number; why: string }> {
  const fps = timelineFps(tl);
  const len = Math.round(seconds * fps);
  const tests: Array<[string, (c: Clip, t: Track) => boolean]> = [
    ['text', (c) => !!c.text],
    ['rounded', (c) => (c.corner_radius ?? 0) > 0],
    ['crop', (c) => !!(c.crop_left || c.crop_right || c.crop_top || c.crop_bottom)],
    ['keyframes', (c) => !!c.chroma_keyframes?.length],
    ['fades', (c) => (c.fade_in_frames ?? 0) > 0 || (c.fade_out_frames ?? 0) > 0],
    ['grade', (c) => graded.has(c.id)],
    ['captions', (_c, t) => t.kind === 'subtitle'],
    ['highlights', (c) => !!c.highlights?.length],
  ];
  const out: Array<{ start: number; end: number; why: string }> = [];
  for (const [why, test] of tests) {
    let hit: Clip | undefined;
    for (const t of tl.tracks) {
      if (t.kind === 'audio') continue;
      hit = t.clips.find((c) => test(c, t));
      if (hit) break;
    }
    if (!hit) continue;
    // A fade-in starts at the clip's head; everything else is caught a little in.
    const start = Math.max(0, why === 'fades' ? hit.start_frame : hit.start_frame + Math.round(fps * 0.25));
    const end = Math.min(start + len, Math.max(start + 1, endFrame(hit, fps) + (why === 'fades' ? Math.round(fps) : 0)));
    if (out.some((w) => start < w.end && end > w.start)) continue;
    out.push({ start, end: Math.max(end, start + Math.round(fps)), why });
  }
  return out;
}

// ---------------------------------------------------------------- coverage --

const COVERAGE_FPS = 30;
const sec = (s: number) => Math.round(s * COVERAGE_FPS);

/**
 * A timeline built from the copy's own footage for what the owner's projects do
 * not use. Two picture sources (`a`, the longest camera-like clip, and `b`, a
 * second source of a different size or rate when the pool has one), 2 s per
 * effect, on three video tracks plus `a`'s audio.
 */
function coverageTimeline(id: string, a: MediaItem, b: MediaItem, grades: Plan['coverageGrades']): Timeline {
  const fpsOf = (m: MediaItem) => m.video?.fps ?? COVERAGE_FPS;
  const lenOf = (m: MediaItem) => m.video?.frameCount ?? sec(60);
  const c = (cid: string, m: MediaItem, startSec: number, durSec: number, srcSec: number, over: Partial<Clip> = {}): Clip => {
    const sf = fpsOf(m);
    return {
      id: cid,
      name: cid,
      media_id: m.id,
      source_path: m.sourcePath,
      source_fps: sf,
      source_len: lenOf(m),
      source_start: Math.round(srcSec * sf),
      duration: Math.round(durSec * sf),
      start_frame: sec(startSec),
      // Sized into the frame (a 4K source in the 1080p coverage timeline).
      scaling: 'fit',
      ...over,
    };
  };
  grades['cov-grade-primary'] = 'primary';
  grades['cov-grade-xform'] = 'curves_lut';
  grades['cov-grade-mask'] = 'mask';
  const zoomed = c('cov-zoom', a, 12, 2, 40);
  const span = dynamicZoomSpan(zoomed);
  zoomed.chroma_keyframes = applyDynamicZoom(
    undefined,
    { position_x: 0, position_y: 0, scale: 1 },
    { position_x: -0.25, position_y: -0.1, scale: 1.5 },
    span.first,
    span.last,
  );
  const base: Track = {
    kind: 'video',
    clips: [
      c('cov-grade-primary', a, 0, 2, 5),
      c('cov-plain-1', b, 2, 2, 3),
      // 4 s: a cross dissolve into this clip (centred on the cut, so both sides need handles).
      c('cov-dissolve-in', a, 4, 2, 20),
      // 6 s: a dip to colour into this one.
      c('cov-dip-in', b, 6, 2, 9),
      c('cov-under-adjustment', a, 8, 2, 28),
      // 1.5 s of source at 2x, then 0.5 s at 0.5x: 1.75 s on the timeline.
      c('cov-speed', a, 10, 2, 32, { speed_points: [{ source_frame: Math.round(32 * fpsOf(a)), speed: 2 }, { source_frame: Math.round(33.5 * fpsOf(a)), speed: 0.5 }] }),
      zoomed,
      c('cov-highlight', a, 14, 2, 44, { highlights: [{ box: [0.3, 0.3, 0.6, 0.5], at: 10, dur: 30 }] }),
      c('cov-grade-mask', a, 16, 2, 48),
      c('cov-fades', b, 18, 2, 12, { fade_in_frames: Math.round(0.5 * fpsOf(b)), fade_out_frames: Math.round(0.5 * fpsOf(b)) }),
    ],
    transitions: [
      { id: 'cov-t-dissolve', kind: 'cross_dissolve', at_frame: sec(4), duration: sec(0.8), alignment: 'center_at_cut' },
      { id: 'cov-t-dip', kind: 'dip_to_color', at_frame: sec(6), duration: sec(0.8), alignment: 'center_at_cut', color: '#202040' },
    ],
  };
  const mid: Track = {
    kind: 'video',
    clips: [
      // A graded clip under a transform and a crop, rounded, over the base.
      c('cov-grade-xform', b, 0, 2, 6, {
        scale: 0.45,
        position_x: 0.5,
        position_y: 0.1,
        crop_left: 0.1,
        crop_right: 0.05,
        corner_radius: 24,
      }),
    ],
  };
  const top: Track = {
    kind: 'video',
    clips: [
      {
        id: 'cov-adjustment',
        name: 'adjustment',
        source_path: '',
        source_start: 0,
        duration: sec(2),
        source_len: sec(2),
        start_frame: sec(8),
        adjustment: { exposure: 0.3, contrast: 0.25, saturation: -0.4, temperature: 0.3, tint: -0.1 },
      },
    ],
  };
  const audio: Track = {
    kind: 'audio',
    clips: [c('cov-audio', a, 0, 20, 5, { volume: 0.8 })],
  };
  return { id, name: 'parity coverage', rate: { num: COVERAGE_FPS, den: 1 }, tracks: [top, mid, base, audio], output: { width: 1920, height: 1080 } };
}

/** A short timeline for the export-time Clip exceptions: `a` sped up and
 *  stretched beside `b`, with `a` holding its last frame to the end. */
function exceptionsTimeline(id: string, a: MediaItem, b: MediaItem): Timeline {
  const sf = (m: MediaItem) => m.video?.fps ?? COVERAGE_FPS;
  const clip = (cid: string, m: MediaItem, srcSec: number, durSec: number, over: Partial<Clip>): Clip => ({
    id: cid,
    name: cid,
    media_id: m.id,
    source_path: m.sourcePath,
    source_fps: sf(m),
    source_len: m.video?.frameCount ?? sec(60),
    source_start: Math.round(srcSec * sf(m)),
    duration: Math.round(durSec * sf(m)),
    start_frame: 0,
    scaling: 'fit',
    ...over,
  });
  return {
    id,
    name: 'parity clip exceptions',
    rate: { num: COVERAGE_FPS, den: 1 },
    output: { width: 1920, height: 1080 },
    tracks: [
      { kind: 'video', clips: [clip('exc-fast', a, 10, 3, { scale: 0.5, position_x: 0, position_y: 0.25, crop_top: 0.2, crop_bottom: 0.2 })] },
      { kind: 'video', clips: [clip('exc-long', b, 4, 3, { scale: 0.5, position_x: 0.5, position_y: 0.25 })] },
    ],
  };
}

// --------------------------------------------------------------------- run --

function loadProject(): { timelines: Timeline[]; media: MediaItem[] } {
  if (!facts) throw new Error('no facts');
  const raw = JSON.parse(readFileSync(facts.projectJson, 'utf8')) as { timelines: Timeline[]; media: MediaItem[] };
  return { timelines: raw.timelines, media: raw.media };
}

function gradedIds(): Set<string> {
  return new Set(Object.keys(facts?.gradeLuts?.luts ?? {}));
}

function buildPlan(): Plan {
  if (!facts) throw new Error('no facts');
  const { timelines, media } = loadProject();
  useMediaPoolStore.setState({ items: media });
  const wanted = (process.env.APELLES_PARITY_TIMELINES ?? '').split('|').filter(Boolean);
  const full = new Set((process.env.APELLES_PARITY_FULL ?? '').split('|').filter(Boolean));
  const seconds = Number(process.env.APELLES_PARITY_RANGE_SECS ?? '3');
  const graded = new Set<string>();
  // A clip has a grade on disk when the Rust half listed one for it.
  const gradedFile = process.env.APELLES_PARITY_GRADED_FILE;
  if (gradedFile) for (const id of readFileSync(gradedFile, 'utf8').split('\n').filter(Boolean)) graded.add(id);
  const plan: Plan = { cases: [], coverageGrades: {}, captionRequests: [] };
  const add = (label: string, src: Timeline, tl: Timeline, exportArgs: Record<string, unknown> = {}) => {
    const comp = facts.compSizes[src.id] ?? (tl.output ? { compWidth: tl.output.width, compHeight: tl.output.height } : undefined);
    if (!comp) throw new Error(`no composition size for ${src.id}`);
    plan.cases.push({ label, effects: effectsOf(tl, graded, media), sourceTimelineId: src.id, timeline: tl, ...size1080(comp), exportArgs });
  };
  for (const tl of timelines) {
    if (!tl.tracks.some((t) => t.kind === 'video' && t.clips.length)) continue;
    if (wanted.length && !wanted.includes(tl.name) && !full.has(tl.name)) continue;
    if (full.has(tl.name)) add(`full: ${tl.name}`, tl, { ...tl, id: `${tl.id}#full` });
    if (!wanted.includes(tl.name)) continue;
    for (const w of windowsFor(tl, graded, seconds)) {
      add(`${tl.name} @${(w.start / timelineFps(tl)).toFixed(1)}s (${w.why})`, tl, sliceCase(tl, w.start, w.end, `${tl.id}#${w.start}`));
    }
  }
  if (process.env.APELLES_PARITY_COVERAGE === '1') {
    const pictures = media
      .filter((m) => (m.video?.width ?? 0) > 0 && (m.video?.frameCount ?? 0) > 0)
      .sort((x, y) => (y.video?.frameCount ?? 0) - (x.video?.frameCount ?? 0));
    const a = pictures[0];
    const b = pictures.find((m) => m.video?.fps !== a?.video?.fps || m.video?.width !== a?.video?.width) ?? pictures[1];
    if (!a || !b) throw new Error('coverage needs two picture sources in the pool');
    const cov = coverageTimeline('parity-coverage', a, b, plan.coverageGrades);
    add('coverage: transitions, adjustment, speed ramp, dynamic zoom, highlights, grades', cov, cov);
    const exc = exceptionsTimeline('parity-exceptions', a, b);
    add('clip exceptions: speed override', exc, { ...exc, id: 'parity-exceptions#speed' }, { speedOverrides: { 'exc-fast': 2 } });
    add('clip exceptions: stretch to fill', exc, { ...exc, id: 'parity-exceptions#stretch' }, { fitOverrides: { 'exc-fast': 'stretch' } });
    add('clip exceptions: hold last frame', exc, { ...exc, id: 'parity-exceptions#freeze' }, { speedOverrides: { 'exc-fast': 2 }, freezeOverrides: { 'exc-fast': true } });
  }
  for (const c of plan.cases) caseSource.set(c.timeline.id, c.sourceTimelineId);
  return plan;
}

describe.skipIf(!STAGE)('B-380 — real-project export parity (harness; driven by export_parity_real.rs)', () => {
  it('plans the cases and lists what must be measured first', async () => {
    if (STAGE !== 'plan') return;
    const plan = buildPlan();
    for (const c of plan.cases) {
      await warmAnimatedCaptionMetrics(c.width, c.height, timelineFps(c.timeline), c.timeline);
    }
    plan.captionRequests = recordedCaptionRequests;
    writeFileSync(process.env.APELLES_PARITY_OUT ?? '', JSON.stringify(plan));
    expect(plan.cases.length).toBeGreaterThan(0);
  });

  it('compiles every case on both renderers', async () => {
    if (STAGE !== 'compile') return;
    const plan = JSON.parse(readFileSync(process.env.APELLES_PARITY_PLAN ?? '', 'utf8')) as Plan;
    const { media } = loadProject();
    useMediaPoolStore.setState({ items: media });
    for (const c of plan.cases) caseSource.set(c.timeline.id, c.sourceTimelineId);
    await loadTextFonts();
    const out = [];
    for (const c of plan.cases) {
      const fps = timelineFps(c.timeline);
      await warmCompositionSize(c.timeline.id);
      await warmAnimatedCaptionMetrics(c.width, c.height, fps, c.timeline);
      await warmGradeLuts(c.timeline);
      const graded = gradedIds();
      const base = { outPath: '/OUT.mp4', timelineId: c.timeline.id, width: c.width, height: c.height, encoder: 'hardware', ...c.exportArgs };
      const filter = compileEditorExportArgs({ ...base, renderer: 'filter' }, c.timeline);
      const pipe = compileEditorExportArgs({ ...base, renderer: 'compositor' }, c.timeline);
      out.push({
        label: c.label,
        effects: effectsOf(c.timeline, graded, media),
        timeline: c.timeline,
        width: c.width,
        height: c.height,
        fps,
        filterArgs: 'ok' in filter ? filter.args : null,
        filterError: 'ok' in filter ? null : filter.error,
        pipeArgs: 'ok' in pipe ? pipe.args : null,
        pipeError: 'ok' in pipe ? null : pipe.error,
        pipeFrames: 'ok' in pipe ? (pipe.render?.frames ?? null) : null,
        segmentArgs: 'ok' in pipe ? (pipe.render?.segments?.segmentArgs ?? null) : null,
        concatArgs: 'ok' in pipe ? (pipe.render?.segments?.concatArgs ?? null) : null,
      });
    }
    writeFileSync(process.env.APELLES_PARITY_OUT ?? '', JSON.stringify({ cases: out }));
    expect(out.length).toBe(plan.cases.length);
  });
});
