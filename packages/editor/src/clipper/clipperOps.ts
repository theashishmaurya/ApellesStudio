/**
 * `@apelles/editor` — the Automatic Clipper's ops: one function per
 * capability, called by the `editor_*clip*` MCP ops (`useEditorControl`) and
 * by the Clipper panel alike, so the agent and the person drive one store and
 * one gate (CLAUDE.md: human AND AI; D-411).
 *
 * **The loop (D-411, owner decision 2026-10-27: the MCP client is the only
 * judge).**
 *
 * 1. [`startAutoClip`] — `editor_auto_clip`: create a run for a source (a
 *    media file or a long timeline), start what the analysis needs (the
 *    transcript in windows, the audio and picture evidence passes) and answer
 *    with the job status and page 0 of the moment view with its judging rules.
 *    It picks nothing.
 * 2. [`momentView`] — `editor_get_moment_view`: the rest of the pages.
 * 3. [`proposeClips`] — `editor_propose_clips`: the client's picks through the
 *    clean-cut gate, stored in the run, and (by default) the passing ones
 *    built straight away as timelines in this project — the one call that
 *    stops at built timelines (`export` optional).
 * 4. [`setClipProposal`] / [`buildClips`] — review: accept, reject, nudge an
 *    edge by a sentence or a word (re-gated), rebuild — never over a person's
 *    edits unless they choose "new version" or "replace".
 *
 * **What it does NOT do.** Judge: there is no path here that chooses a
 * moment. Analysis and gating are Rust (`chroma::clipper`); a short's body is
 * `clipBuild.ts`.
 */
import { invoke } from '@tauri-apps/api/core';
import { useMediaPoolStore, type MediaItem } from '@apelles/bridge';
import { readProjectKit } from '@apelles/brand';

import { brandCaptionStyle } from '../brandEdit';
import type { CaptionStyle } from '../caption';
import { captionPresetById, captionPresetIds } from '../captionPresets';
import { prepareEditorExport } from '../editorExport';
import { useExportQueueStore } from '../exportQueueStore';
import { useMediaUnderstandingStore } from '../mediaUnderstandingStore';
import { spanToFrames } from '../recut';
import { timelineFps, type OutputSpec, type Timeline, type TimelineOrigin } from '../timeline';
import { useEditorTimelineStore } from '../timelineStore';
import { buildShortBody, type SourceMedia } from './clipBuild';
import {
  retakeCutsFor,
  viewInputFor,
  viewRequest,
  type ClipperViewInput,
  type TranscriptSnapshot,
} from './clipperSource';
import { useClipperStore } from './clipperStore';
import {
  ALLOWED_DURATIONS,
  ASPECT_OUTPUT,
  ASPECTS,
  CLIP_RUN_SCHEMA,
  MAX_CLIP_COUNT,
  type AnalyzeWire,
  type Aspect,
  type CheckVerdictWire,
  type CheckWire,
  type ClipProposal,
  type ClipRun,
  type RunSettings,
  type RunSource,
} from './clipperTypes';

type OpArgs = Record<string, unknown> | undefined;
type OpError = { error: string };

/** The caption preset a short gets when the project has no brand kit. */
export const DEFAULT_SHORT_CAPTION_PRESET = 'caption-pill-karaoke';
/** The targets a run asks for when none are given (the design's default). */
export const DEFAULT_DURATIONS = [30, 60];
/** Shorts a run asks for when no count is given. */
export const DEFAULT_COUNT = 5;
/** The longest title a proposal may carry (the served rules say 60). */
export const MAX_TITLE_CHARS = 80;

// ------------------------------------------------------------ helpers

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

function snapshot(): TranscriptSnapshot {
  const s = useMediaUnderstandingStore.getState();
  return {
    transcripts: s.transcripts,
    partialTranscripts: s.partialTranscripts,
    transcriptErrors: s.transcriptErrors,
    recoveriesFor: s.recoveriesFor,
  };
}

/** A run id: `run-<yyyymmdd>-<hhmmss>-<4 random>`, valid as a file stem. */
export function newRunId(now = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  return `run-${stamp}-${Math.random().toString(36).slice(2, 6).padEnd(4, '0')}`;
}

function mediaFacts(item: MediaItem): SourceMedia | null {
  const v = item.video;
  if (!v || item.offline) return null;
  return {
    mediaId: item.id,
    name: item.name,
    path: item.sourcePath,
    width: v.width,
    height: v.height,
    fps: v.fps,
    frameCount: v.frameCount,
    hasAudio: v.hasAudio === true,
  };
}

/** Timelines this run's source or build may need, by id (the open one from
 *  the store, any other from the backend). */
async function timelineById(id: string): Promise<Timeline | null> {
  const s = useEditorTimelineStore.getState();
  if (s.timeline?.id === id) return s.timeline;
  try {
    return await invoke<Timeline>('chroma_timeline_get_by_id', { id });
  } catch {
    return null;
  }
}

/** The run's source resolved against the project now. */
async function resolveView(run: ClipRun): Promise<ClipperViewInput | OpError> {
  const media = useMediaPoolStore.getState().items;
  const tl = run.source.kind === 'timeline' ? await timelineById(run.source.timeline_id) : null;
  return viewInputFor(run.source, run.settings, { media, timelineById: () => tl }, snapshot());
}

function request(run: ClipRun, input: ClipperViewInput) {
  const open = useEditorTimelineStore.getState().timeline;
  const cuts = run.settings.tighten.retakes
    ? retakeCutsFor(input, open, useMediaUnderstandingStore.getState().retakeProposals)
    : [];
  return viewRequest(input, run.settings, cuts);
}

function runOf(a: OpArgs): ClipRun | OpError {
  const s = useClipperStore.getState();
  const id = typeof a?.runId === 'string' && a.runId ? a.runId : s.activeRunId;
  if (!id) return { error: 'run_id is required — editor_auto_clip returns one, editor_list_clip_proposals lists them' };
  const run = s.runs[id];
  return run ?? { error: `no clip run ${id} in this project (editor_list_clip_proposals lists them)` };
}

// ------------------------------------------------------------ settings

/** Parse the settings of a new run, refusing anything out of range by name. */
export function parseSettings(a: OpArgs): RunSettings | OpError {
  const durations = a?.durations === undefined || a?.durations === null ? DEFAULT_DURATIONS : a.durations;
  if (!Array.isArray(durations) || durations.length === 0) return { error: `durations must be a list of target seconds from ${ALLOWED_DURATIONS.join(', ')}` };
  const ds: number[] = [];
  for (const d of durations) {
    const n = Number(d);
    if (!(ALLOWED_DURATIONS as readonly number[]).includes(n)) return { error: `${String(d)} s is not a target length; choose from ${ALLOWED_DURATIONS.join(', ')}` };
    if (!ds.includes(n)) ds.push(n);
  }
  ds.sort((x, y) => x - y);
  const count = a?.count === undefined || a?.count === null ? DEFAULT_COUNT : Math.round(Number(a.count));
  if (!Number.isInteger(count) || count < 1 || count > MAX_CLIP_COUNT) return { error: `count must be 1-${MAX_CLIP_COUNT}` };
  const aspect = (a?.aspect ?? '9:16') as Aspect;
  if (!ASPECTS.includes(aspect)) return { error: `aspect must be one of ${ASPECTS.join(', ')}` };
  const captions = typeof a?.captions === 'string' && a.captions ? a.captions : 'brand';
  if (captions !== 'brand' && captions !== 'none' && !captionPresetById(captions)) {
    return { error: `captions must be "brand", "none" or a caption preset id: ${captionPresetIds().join(', ')}` };
  }
  let range: RunSettings['range'] = null;
  if (a?.rangeStartS !== undefined || a?.rangeEndS !== undefined) {
    const start = Number(a?.rangeStartS ?? 0);
    const end = Number(a?.rangeEndS);
    if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start) {
      return { error: 'range_start_s / range_end_s must be seconds with the start before the end' };
    }
    range = { start_secs: start, end_secs: end };
  }
  const focus = typeof a?.focus === 'string' && a.focus.trim() ? a.focus.trim() : null;
  return {
    durations: ds,
    count,
    aspect,
    captions,
    hook_first: a?.hookFirst === undefined ? true : !!a.hookFirst,
    tighten: {
      dead_air: a?.tightenDeadAir === undefined ? true : !!a.tightenDeadAir,
      retakes: a?.tightenRetakes === undefined ? true : !!a.tightenRetakes,
    },
    range,
    focus,
  };
}

/** The run source an op names: `media_id`, `path`, or `timeline_id`
 *  (+ `track`); none = the open timeline. */
async function parseSource(a: OpArgs): Promise<RunSource | OpError> {
  const media = useMediaPoolStore.getState().items;
  if (typeof a?.mediaId === 'string' || typeof a?.path === 'string') {
    const item =
      typeof a?.mediaId === 'string'
        ? media.find((m) => m.id === a.mediaId)
        : media.find((m) => m.sourcePath === a?.path);
    if (!item) return { error: 'no media-pool item with that media_id / path — import it first (editor_import_media)' };
    if (!item.video) return { error: `${item.name} is not a probed video or audio file` };
    return { kind: 'media', media_id: item.id, path: item.sourcePath, name: item.name };
  }
  const s = useEditorTimelineStore.getState();
  const id = typeof a?.timelineId === 'string' && a.timelineId ? a.timelineId : s.timeline?.id;
  if (!id) return { error: 'no source: pass media_id, path or timeline_id, or open a timeline' };
  const tl = await timelineById(id);
  if (!tl) return { error: `no timeline ${id} in this project` };
  let track: number;
  if (a?.track !== undefined && a?.track !== null) {
    track = Math.round(Number(a.track));
    if (!tl.tracks[track]) return { error: `no track ${String(a.track)} on "${tl.name}" (0..${tl.tracks.length - 1})` };
  } else {
    track = tl.tracks.findIndex((t) => t.kind !== 'subtitle' && t.clips.some((c) => !!c.source_path));
    if (track < 0) return { error: `"${tl.name}" has no clips with a source to clip from` };
  }
  return { kind: 'timeline', timeline_id: tl.id, track, name: tl.name };
}

// ------------------------------------------------------------ analysis

/** What a run's analysis is waiting on, per source file. */
interface SourceProgress {
  path: string;
  transcript: 'done' | 'transcribing' | 'idle' | 'error';
  coveredSecs?: number;
  durationSecs?: number;
  windows?: string;
  error?: string;
}

/** Start what the analysis needs and report where each file is. Starts
 *  nothing already running or done. */
async function kick(run: ClipRun): Promise<SourceProgress[] | OpError> {
  const media = useMediaPoolStore.getState().items;
  let paths: string[];
  if (run.source.kind === 'media') {
    paths = [run.source.path];
  } else {
    const tl = await timelineById(run.source.timeline_id);
    if (!tl) return { error: `timeline ${run.source.timeline_id} is not in the project` };
    const track = tl.tracks[run.source.track];
    paths = [...new Set((track?.clips ?? []).map((c) => c.source_path).filter((p): p is string => !!p))];
  }
  const store = useMediaUnderstandingStore.getState();
  const out: SourceProgress[] = [];
  for (const path of paths) {
    const item = media.find((m) => m.sourcePath === path);
    const duration = item?.video?.durationSecs ?? 0;
    if (!store.transcripts[path]) {
      if (duration > 0) store.startProgressiveTranscript(path, duration);
      else store.startTranscript(path, { wordTimestamps: true });
    }
    const hasPicture = !!item?.video && item.video.width > 0 && item.video.height > 0;
    try {
      await invoke('chroma_clipper_evidence_start', { path, audio: item?.video?.hasAudio !== false, scenes: hasPicture });
    } catch (e: unknown) {
      // Evidence is optional: the analysis is complete from the transcript.
      console.warn('[clipper] evidence pass could not start for', path, message(e));
    }
    const s = useMediaUnderstandingStore.getState();
    const partial = s.partialTranscripts[path];
    out.push({
      path,
      transcript: s.transcripts[path] ? 'done' : s.transcriptErrors[path] ? 'error' : s.transcribing[path] ? 'transcribing' : 'idle',
      ...(partial
        ? { coveredSecs: Math.round(partial.coveredSecs), durationSecs: Math.round(partial.durationSecs), windows: `${partial.windowsDone}/${partial.windowsTotal}` }
        : {}),
      ...(s.transcriptErrors[path] ? { error: s.transcriptErrors[path] } : {}),
    });
  }
  return out;
}

/** Analyse a run's source now (`render`: a page of the moment view;
 *  `includeAnalysis`: the data the panel draws). */
export async function analyseRun(
  run: ClipRun,
  opts: { offset?: number; maxSentences?: number | null; render?: boolean; includeAnalysis?: boolean } = {},
): Promise<{ wire: AnalyzeWire; input: ClipperViewInput } | { pending: ClipperViewInput } | OpError> {
  const input = await resolveView(run);
  if ('error' in input) return input;
  if (input.failed.length > 0) return { error: `transcription failed for ${input.failed[0].path}: ${input.failed[0].error}` };
  if (input.pieces.length === 0 || input.pending.length > 0) return { pending: input };
  let wire: AnalyzeWire;
  try {
    wire = await invoke<AnalyzeWire>('chroma_clipper_analyze', {
      request: {
        ...request(run, input),
        offset: opts.offset ?? 0,
        maxSentences: opts.maxSentences ?? null,
        render: !!opts.render,
        includeAnalysis: !!opts.includeAnalysis,
      },
    });
  } catch (e: unknown) {
    return { error: `the analysis failed: ${message(e)}` };
  }
  if (opts.includeAnalysis) useClipperStore.getState().setAnalysis(run.id, { wire, provisional: input.provisional, at: Date.now() });
  return { wire, input };
}

function viewNote(wire: AnalyzeWire, provisional: boolean): string {
  if (provisional) {
    return 'PROVISIONAL: the source is still being transcribed in windows; this view covers the part done so far and its sentence numbers may still change at the end. Read it, but propose only once state is "ready" (poll editor_auto_clip_status).';
  }
  return wire.nextOffset === null
    ? 'that is the whole view — judge it by the instructions, then propose with editor_propose_clips and this view_id'
    : `more sentences follow — call editor_get_moment_view with offset: ${wire.nextOffset} (same view_id while the source is unchanged)`;
}

/** The status block every clipper answer carries. */
async function status(run: ClipRun, analysed?: { wire: AnalyzeWire; input: ClipperViewInput } | { pending: ClipperViewInput }) {
  const progress = await kick(run);
  if ('error' in progress) return progress;
  const provisional = !!analysed && 'wire' in analysed && analysed.input.provisional;
  const ready = !!analysed && 'wire' in analysed && !provisional;
  return {
    runId: run.id,
    state: ready ? 'ready' : 'transcribing',
    sources: progress,
    evidence: analysed && 'wire' in analysed ? analysed.wire.evidence : [],
    sentences: analysed && 'wire' in analysed ? analysed.wire.totalSentences : 0,
    topics: analysed && 'wire' in analysed ? analysed.wire.topics : 0,
    candidates: analysed && 'wire' in analysed ? analysed.wire.candidates : 0,
    proposals: run.proposals.length,
    built: run.proposals.filter((p) => p.status === 'built').map((p) => ({ id: p.id, timelineId: p.timeline_id ?? null, title: p.title })),
  };
}

function viewBlock(wire: AnalyzeWire, provisional: boolean) {
  return {
    viewId: wire.viewId,
    provisional,
    totalSentences: wire.totalSentences,
    offset: wire.offset,
    returned: wire.returned,
    nextOffset: wire.nextOffset,
    rulesVersion: wire.rulesVersion,
    ...(wire.rules ? { instructions: wire.rules } : {}),
    text: wire.text ?? '',
    note: viewNote(wire, provisional),
  };
}

// ------------------------------------------------------------ the ops

/** `editor_auto_clip`. */
export async function startAutoClip(a: OpArgs) {
  if (a?.outputs !== undefined && a.outputs !== 'shorts') {
    return { error: 'outputs: only "shorts" is built so far — the trailer is D-411 Phase 6, not built yet' };
  }
  let run: ClipRun;
  if (typeof a?.runId === 'string' && a.runId) {
    const existing = runOf(a);
    if ('error' in existing) return existing;
    run = existing;
  } else {
    const source = await parseSource(a);
    if ('error' in source) return source;
    const settings = parseSettings(a);
    if ('error' in settings) return settings;
    run = {
      schema: CLIP_RUN_SCHEMA,
      id: newRunId(),
      created_at: new Date().toISOString(),
      source,
      settings,
      view_id: null,
      proposals: [],
    };
    const saved = await useClipperStore.getState().saveRun(run);
    if ('error' in saved) return saved;
  }
  useClipperStore.getState().setActiveRun(run.id);
  await kick(run);
  const analysed = await analyseRun(run, { render: true, maxSentences: numOrNull(a?.maxSentences), includeAnalysis: true });
  if ('error' in analysed) return analysed;
  const st = await status(run, analysed);
  if ('error' in st) return st;
  return {
    ok: true,
    ...st,
    settings: run.settings,
    ...('wire' in analysed ? { view: viewBlock(analysed.wire, analysed.input.provisional) } : {}),
    note:
      st.state === 'ready'
        ? `Analysed. Nothing is picked: read the moment view (judge by its instructions), then call editor_propose_clips with run_id ${run.id}, the view_id and your ${run.settings.count} best shorts — they are gated and built as ${run.settings.aspect} timelines in this project.`
        : 'Analysing: the transcript is still being read (in 5-minute windows). Poll editor_auto_clip_status; a provisional view of the part done so far is included when there is one.',
  };
}

const numOrNull = (v: unknown): number | null => {
  if (v === undefined || v === null) return null;
  const n = Math.round(Number(v));
  return Number.isFinite(n) && n > 0 ? n : null;
};

/** `editor_auto_clip_status`. */
export async function autoClipStatus(a: OpArgs) {
  const run = runOf(a);
  if ('error' in run) return run;
  const analysed = await analyseRun(run, { includeAnalysis: true });
  if ('error' in analysed) return analysed;
  const st = await status(run, analysed);
  if ('error' in st) return st;
  return { ok: true, ...st, ...('wire' in analysed ? { viewId: analysed.wire.viewId, provisional: analysed.input.provisional } : {}) };
}

/** `editor_get_moment_view`. */
export async function momentView(a: OpArgs) {
  const run = runOf(a);
  if ('error' in run) return run;
  const offset = a?.offset === undefined || a?.offset === null ? 0 : Math.round(Number(a.offset));
  if (!Number.isFinite(offset) || offset < 0) return { error: 'offset must be a non-negative sentence number' };
  const analysed = await analyseRun(run, { offset, maxSentences: numOrNull(a?.maxSentences), render: true });
  if ('error' in analysed) return analysed;
  if ('pending' in analysed) {
    const st = await status(run, analysed);
    if ('error' in st) return st;
    return { ok: true, ...st, note: 'no words yet — the transcript is still being read; poll editor_auto_clip_status' };
  }
  return { ok: true, runId: run.id, ...viewBlock(analysed.wire, analysed.input.provisional) };
}

/** One client clip off the wire. */
interface ClientClip {
  segments: Array<{ first: number; last: number }>;
  hook: { first: number; last: number } | null;
  title: string;
  reason: string;
  hookLine: string | null;
}

const isIdx = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0;

function parseRange(raw: unknown): { first: number; last: number } | null {
  const r = raw as { first?: unknown; last?: unknown } | null;
  return r && isIdx(r.first) && isIdx(r.last) ? { first: r.first, last: r.last } : null;
}

/** Parse the client's clips. Strict about shape; the gate judges the rest. */
export function parseClientClips(raw: unknown): ClientClip[] | OpError {
  if (!Array.isArray(raw)) return { error: 'clips must be an array of {segments, hook?, title, reason, hook_line?}' };
  const out: ClientClip[] = [];
  for (let i = 0; i < raw.length; i += 1) {
    const c = raw[i] as Record<string, unknown> | null;
    if (!c || !Array.isArray(c.segments) || c.segments.length === 0) return { error: `clip ${i}: segments must be a non-empty list of {first, last} sentence ranges` };
    const segments = c.segments.map(parseRange);
    if (segments.some((s) => s === null)) return { error: `clip ${i}: every segment is {first, last} with whole, non-negative sentence numbers` };
    const hook = c.hook === undefined || c.hook === null ? null : parseRange(c.hook);
    if (c.hook !== undefined && c.hook !== null && !hook) return { error: `clip ${i}: hook is {first, last} sentence numbers` };
    const title = typeof c.title === 'string' ? c.title.trim() : '';
    const reason = typeof c.reason === 'string' ? c.reason.trim() : '';
    if (!title) return { error: `clip ${i}: a title is required (the short's headline, at most ${MAX_TITLE_CHARS} characters)` };
    if (title.length > MAX_TITLE_CHARS) return { error: `clip ${i}: the title is ${title.length} characters; at most ${MAX_TITLE_CHARS}` };
    if (!reason) return { error: `clip ${i}: a reason is required — one line a person can check against the words` };
    const rawHook = c.hook_line ?? c.hookLine;
    const hookLine = typeof rawHook === 'string' && rawHook.trim() ? rawHook.trim() : null;
    out.push({ segments: segments as Array<{ first: number; last: number }>, hook, title, reason, hookLine });
  }
  return out;
}

async function check(run: ClipRun, input: ClipperViewInput, viewId: string, shapes: Array<{ segments: Array<{ first: number; last: number }>; hook: { first: number; last: number } | null; unit: 'sentence' | 'word' }>) {
  return invoke<CheckWire>('chroma_clipper_check', { request: { ...request(run, input), viewId, proposals: shapes } });
}

function notesOf(v: CheckVerdictWire): string[] {
  return v.status === 'refused' ? [v.reasonText ?? 'refused'] : v.warnings;
}

const stale = (current: string) =>
  `stale view_id: the source changed since you read it (a finished transcript, an applied re-read, an edit to the source timeline) — the current view is ${current}. Re-read with editor_get_moment_view, re-derive your sentence numbers and resubmit. Nothing was changed.`;

/** Proposal ids continue from the run's highest. */
function nextIds(run: ClipRun, n: number): string[] {
  const max = run.proposals.reduce((m, p) => Math.max(m, Number(p.id.replace(/^p/, '')) || 0), 0);
  return Array.from({ length: n }, (_, i) => `p${max + i + 1}`);
}

/** `editor_propose_clips`. */
export async function proposeClips(a: OpArgs) {
  const run = runOf(a);
  if ('error' in run) return run;
  const clips = parseClientClips(a?.clips);
  if ('error' in clips) return clips;
  const viewId = typeof a?.viewId === 'string' ? a.viewId : '';
  if (!viewId) return { error: 'view_id is required — the viewId editor_auto_clip / editor_get_moment_view returned' };
  const input = await resolveView(run);
  if ('error' in input) return input;
  if (input.pending.length > 0 || input.pieces.length === 0 || input.provisional) {
    return { error: 'the source is still being transcribed — proposals wait for the whole transcript (poll editor_auto_clip_status until state is "ready")' };
  }
  let checked: CheckWire;
  try {
    checked = await check(run, input, viewId, clips.map((c) => ({ segments: c.segments, hook: c.hook, unit: 'sentence' as const })));
  } catch (e: unknown) {
    return { error: `the gate failed: ${message(e)}` };
  }
  if (checked.stale) return { error: stale(checked.viewId), viewId: checked.viewId };
  const ids = nextIds(run, clips.length);
  const fresh: ClipProposal[] = clips.map((c, i) => {
    const v = checked.verdicts[i];
    return {
      id: ids[i],
      shape: v.shape ?? { hook: null, segments: [] },
      title: c.title,
      reason: c.reason,
      hook_line: c.hookLine,
      picked_by: 'client',
      view_id: checked.viewId,
      rules_version: useClipperStore.getState().analyses[run.id]?.wire.rulesVersion ?? 1,
      verdict: v.verdict,
      gate_notes: notesOf(v),
      status: 'pending',
      timeline_id: null,
      built_at: null,
    };
  });
  const kept = a?.replace ? run.proposals.filter((p) => p.status === 'built') : run.proposals;
  const next: ClipRun = { ...run, view_id: checked.viewId, proposals: [...kept, ...fresh] };
  const saved = await useClipperStore.getState().saveRun(next);
  if ('error' in saved) return saved;

  const refused = fresh.filter((p) => p.verdict.verdict === 'refused');
  const build = a?.build === undefined ? true : !!a.build;
  let built: Awaited<ReturnType<typeof buildClips>> | null = null;
  if (build && fresh.length > refused.length) {
    built = await buildClips({ runId: run.id, ids: fresh.filter((p) => p.verdict.verdict !== 'refused').map((p) => p.id), exportDir: a?.exportDir, loudnessPreset: a?.loudnessPreset });
  }
  const final = useClipperStore.getState().runs[run.id] ?? next;
  return {
    ok: true,
    runId: run.id,
    viewId: checked.viewId,
    proposals: fresh.map((p) => proposalDto(final.proposals.find((x) => x.id === p.id) ?? p, checked.verdicts[fresh.indexOf(p)])),
    verified: fresh.filter((p) => p.verdict.verdict === 'verified').length,
    warned: fresh.filter((p) => p.verdict.verdict === 'warned').length,
    refused: refused.length,
    ...(built ? { build: built } : {}),
    note:
      (refused.length > 0
        ? `${refused.length} clip(s) refused by the clean-cut gate — each says why and which sentences; fix the ranges (sentence edges, length within the target's band, not starting inside a retake) and resubmit just those (replace: false adds to the run). `
        : '') +
      (built ? 'The passing clips are built as timelines in this project (the switcher groups them); the person reviews them in the Clipper panel. ' : 'Nothing was built (build: false); editor_build_clips builds them. ') +
      'Work on a short with the ordinary editor_* tools after editor_set_active_timeline.',
  };
}

function proposalDto(p: ClipProposal, v?: CheckVerdictWire) {
  const resolved = p.verdict.verdict === 'refused' ? null : p.verdict.resolved;
  return {
    id: p.id,
    status: p.status,
    gate: p.verdict.verdict,
    notes: p.gate_notes,
    title: p.title,
    reason: p.reason,
    hookLine: p.hook_line ?? null,
    pickedBy: p.picked_by,
    sentences: resolved ? { first: resolved.first_sentence, last: resolved.last_sentence } : (v?.sentences ?? null),
    offendingSentences: v?.offendingSentences ?? [],
    seconds: resolved ? Math.round(resolved.tight_secs * 10) / 10 : null,
    ranges: resolved ? resolved.ranges.map((r) => ({ role: r.role, startSecs: r.start_secs, endSecs: r.end_secs, cuts: r.cuts.length })) : [],
    timelineId: p.timeline_id ?? null,
  };
}

/** `editor_list_clip_proposals`. */
export async function listClipProposals(a: OpArgs) {
  const store = useClipperStore.getState();
  if (Object.keys(store.runs).length === 0) await store.loadRuns();
  const s = useClipperStore.getState();
  if (typeof a?.runId !== 'string' || !a.runId) {
    return {
      ok: true,
      activeRunId: s.activeRunId,
      runs: Object.values(s.runs)
        .sort((x, y) => y.created_at.localeCompare(x.created_at))
        .map((r) => ({
          id: r.id,
          createdAt: r.created_at,
          source: r.source,
          settings: r.settings,
          proposals: r.proposals.length,
          built: r.proposals.filter((p) => p.status === 'built').length,
        })),
      ...(s.loadErrors.length > 0 ? { unreadable: s.loadErrors } : {}),
    };
  }
  const run = runOf(a);
  if ('error' in run) return run;
  return { ok: true, runId: run.id, source: run.source, settings: run.settings, viewId: run.view_id ?? null, proposals: run.proposals.map((p) => proposalDto(p)) };
}

/** `editor_set_clip_proposal`: status, title, and edge nudges by sentence or
 *  word — every change of shape re-gated against the current view. */
export async function setClipProposal(a: OpArgs) {
  const run = runOf(a);
  if ('error' in run) return run;
  const id = typeof a?.id === 'string' ? a.id : '';
  const p = run.proposals.find((x) => x.id === id);
  if (!p) return { error: `no proposal ${id} in run ${run.id}` };
  let next: ClipProposal = { ...p };
  if (a?.status !== undefined) {
    if (a.status !== 'accepted' && a.status !== 'rejected' && a.status !== 'pending') return { error: 'status must be "accepted", "rejected" or "pending"' };
    if (p.status === 'built') return { error: `${id} is built; rebuild it with editor_build_clips instead of changing its status` };
    next.status = a.status;
  }
  if (typeof a?.title === 'string') {
    const t = a.title.trim();
    if (!t || t.length > MAX_TITLE_CHARS) return { error: `title must be 1-${MAX_TITLE_CHARS} characters` };
    next.title = t;
  }
  const nudges = ['extendStart', 'extendEnd', 'wordStart', 'wordEnd'] as const;
  const moved = nudges.some((k) => a?.[k] !== undefined && a?.[k] !== null && Number(a[k]) !== 0) || a?.clearHook === true;
  let verdictWire: CheckVerdictWire | undefined;
  if (moved) {
    const analysed = await analyseRun(run, { includeAnalysis: true });
    if ('error' in analysed) return analysed;
    if ('pending' in analysed || analysed.input.provisional) return { error: 'the source is still being transcribed; nudges wait for the whole transcript' };
    if (analysed.wire.viewId !== p.view_id) return { error: stale(analysed.wire.viewId) };
    const sentences = analysed.wire.analysis?.sentences ?? [];
    const segs = p.shape.segments.map((s) => ({ ...s }));
    const firstSeg = segs[0];
    const lastSeg = segs[segs.length - 1];
    const sentenceOf = (w: number) => sentences.findIndex((s) => s.firstWord <= w && w <= s.lastWord);
    const step = (k: (typeof nudges)[number]) => Math.round(Number(a?.[k] ?? 0));
    if (step('extendStart') !== 0) {
      const s = sentenceOf(firstSeg.first_word) - step('extendStart');
      const target = sentences[Math.max(0, Math.min(sentences.length - 1, s))];
      if (target) firstSeg.first_word = target.firstWord;
    }
    if (step('extendEnd') !== 0) {
      const s = sentenceOf(lastSeg.last_word) + step('extendEnd');
      const target = sentences[Math.max(0, Math.min(sentences.length - 1, s))];
      if (target) lastSeg.last_word = target.lastWord;
    }
    firstSeg.first_word = Math.max(0, firstSeg.first_word - step('wordStart'));
    lastSeg.last_word = Math.max(0, lastSeg.last_word + step('wordEnd'));
    const hook = a?.clearHook === true ? null : p.shape.hook;
    let checked: CheckWire;
    try {
      checked = await check(run, analysed.input, p.view_id, [
        {
          segments: segs.map((s) => ({ first: s.first_word, last: s.last_word })),
          hook: hook ? { first: hook.first_word, last: hook.last_word } : null,
          unit: 'word',
        },
      ]);
    } catch (e: unknown) {
      return { error: `the gate failed: ${message(e)}` };
    }
    if (checked.stale) return { error: stale(checked.viewId) };
    verdictWire = checked.verdicts[0];
    next = { ...next, shape: verdictWire.shape ?? next.shape, verdict: verdictWire.verdict, gate_notes: notesOf(verdictWire) };
    if (next.status === 'accepted' && verdictWire.status === 'refused') next.status = 'pending';
  }
  const saved = await useClipperStore.getState().saveRun({ ...run, proposals: run.proposals.map((x) => (x.id === id ? next : x)) });
  if ('error' in saved) return saved;
  return {
    ok: true,
    proposal: proposalDto(next, verdictWire),
    note: p.status === 'built' && moved ? `${id} is built: rebuild it (editor_build_clips with rebuild: true) for the timeline to follow` : undefined,
  };
}

/** Where a moment of a run's source plays on the long timeline it came from:
 *  switch to that timeline and put the playhead there (the panel's "jump to
 *  source"). A media-file source has no timeline to show it on. */
export async function jumpToSource(run: ClipRun, piece: number, startSecs: number): Promise<{ ok: true } | OpError> {
  if (run.source.kind !== 'timeline') return { error: 'the source is a media file: open the built short to play the moment' };
  const input = await resolveView(run);
  if ('error' in input) return input;
  const clip = input.pieces[piece]?.clip;
  if (!clip) return { error: 'that moment is no longer on the source timeline' };
  const store = useEditorTimelineStore.getState();
  if (store.timeline?.id !== run.source.timeline_id) {
    const switched = await store.setActiveTimeline(run.source.timeline_id);
    if (!switched.ok) return { error: switched.error ?? 'could not open the source timeline' };
  }
  const tl = useEditorTimelineStore.getState().timeline;
  const c = tl?.tracks[clip.track]?.clips.find((x) => x.id === clip.clipId);
  if (!tl || !c) return { error: 'that moment is no longer on the source timeline' };
  useEditorTimelineStore.getState().setPlayhead(spanToFrames(c, startSecs, startSecs, timelineFps(tl)).startFrame);
  return { ok: true };
}

/** Open a built short's timeline. */
export async function openShort(timelineId: string): Promise<{ ok: true } | OpError> {
  const res = await useEditorTimelineStore.getState().setActiveTimeline(timelineId);
  return res.ok ? { ok: true } : { error: res.error ?? 'could not open the short' };
}

// ------------------------------------------------------------ build

/** How a rebuild treats a timeline a person may have edited. */
export type RebuildMode = 'refuse' | 'replace' | 'new_version';

async function captionStyleFor(settings: RunSettings): Promise<{ style: Partial<CaptionStyle> | null; notes: string[] }> {
  if (settings.captions === 'none') return { style: null, notes: [] };
  if (settings.captions !== 'brand') return { style: captionPresetById(settings.captions)?.style ?? null, notes: [] };
  try {
    const kit = await readProjectKit();
    if (kit) {
      const c = brandCaptionStyle(kit);
      if ('error' in c) return { style: captionPresetById(DEFAULT_SHORT_CAPTION_PRESET)?.style ?? null, notes: [c.error] };
      return { style: c.style, notes: [`captions styled by the project's brand kit "${kit.name}"`, ...c.notes] };
    }
  } catch (e: unknown) {
    return { style: captionPresetById(DEFAULT_SHORT_CAPTION_PRESET)?.style ?? null, notes: [message(e)] };
  }
  return { style: captionPresetById(DEFAULT_SHORT_CAPTION_PRESET)?.style ?? null, notes: [] };
}

async function sha(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest).slice(0, 8), (b) => b.toString(16).padStart(2, '0')).join('');
}

/** Build (or rebuild) one proposal. */
async function buildOne(
  run: ClipRun,
  p: ClipProposal,
  input: ClipperViewInput,
  viewId: string,
  mode: RebuildMode,
  rebuild: boolean,
): Promise<{ id: string; ok: true; timelineId: string; name: string; seconds: number; captions: number; tightened: number; warnings: string[]; skipped?: string } | { id: string; ok: false; error: string }> {
  if (p.status === 'rejected') return { id: p.id, ok: false, error: 'rejected — set it to pending or accepted first' };
  if (p.view_id !== viewId) return { id: p.id, ok: false, error: stale(viewId) };
  // Re-gate against the source as it is now (a reviewed retake may have
  // changed what is cut; the view id says the words did not).
  let checked: CheckWire;
  try {
    checked = await check(run, input, viewId, [
      {
        segments: p.shape.segments.map((s) => ({ first: s.first_word, last: s.last_word })),
        hook: p.shape.hook ? { first: p.shape.hook.first_word, last: p.shape.hook.last_word } : null,
        unit: 'word',
      },
    ]);
  } catch (e: unknown) {
    return { id: p.id, ok: false, error: `the gate failed: ${message(e)}` };
  }
  if (checked.stale) return { id: p.id, ok: false, error: stale(checked.viewId) };
  const v = checked.verdicts[0];
  if (v.verdict.verdict === 'refused') return { id: p.id, ok: false, error: `refused by the clean-cut gate: ${v.reasonText ?? ''}` };
  const resolved = v.verdict.resolved;

  const store = useEditorTimelineStore.getState();
  const output: OutputSpec = ASPECT_OUTPUT[run.settings.aspect];
  const existing = p.timeline_id ? await timelineById(p.timeline_id) : null;
  let target: Timeline | null = null;
  if (existing) {
    if (!rebuild) return { id: p.id, ok: true, timelineId: existing.id, name: existing.name, seconds: resolved.tight_secs, captions: 0, tightened: 0, warnings: [], skipped: 'already built — pass rebuild: true to rebuild it' };
    let current: string;
    try {
      current = await invoke<string>('chroma_clipper_content_hash', { timeline: existing });
    } catch (e: unknown) {
      return { id: p.id, ok: false, error: `could not fingerprint ${existing.name}: ${message(e)}` };
    }
    const edited = !!existing.origin?.built_content_hash && current !== existing.origin.built_content_hash;
    if (edited && mode === 'refuse') {
      return {
        id: p.id,
        ok: false,
        error: `"${existing.name}" has been edited since it was built — rebuilding would overwrite those edits. Choose mode "new_version" (a new timeline beside it) or "replace" (overwrite them).`,
      };
    }
    if (mode !== 'new_version') target = existing;
  }
  const name = existing && !target ? `${p.title} v${Date.now().toString(36).slice(-3)}` : p.title;
  if (!target) {
    const created = await store.createTimeline(name, { output, activate: false });
    if (!created.ok || !created.timeline) return { id: p.id, ok: false, error: created.error ?? 'the timeline could not be created' };
    target = created.timeline;
  }

  const media = useMediaPoolStore.getState().items;
  const caption = await captionStyleFor(run.settings);
  const settingsHash = await sha(JSON.stringify({ aspect: run.settings.aspect, captions: run.settings.captions, hook: run.settings.hook_first, tighten: run.settings.tighten }));
  const origin: TimelineOrigin = {
    kind: 'clip_short',
    run_id: run.id,
    proposal_id: p.id,
    source: run.source.kind === 'media' ? { media_id: run.source.media_id } : { timeline_id: run.source.timeline_id },
    segments: resolved.ranges
      .filter((r) => run.settings.hook_first || r.role !== 'hook')
      .map((r) => ({ source_path: input.sources[r.source]?.path ?? '', start_s: r.start_secs, end_s: r.end_secs, role: r.role })),
    built_at_view: viewId,
    settings_hash: settingsHash,
  };
  const mu = useMediaUnderstandingStore.getState();
  const body = buildShortBody({
    base: { id: target.id, name: target.name, rate: target.rate, tracks: [] },
    output,
    view: input,
    resolved,
    mediaFor: (path) => {
      const item = media.find((m) => m.sourcePath === path);
      return item ? mediaFacts(item) : null;
    },
    hookFirst: run.settings.hook_first,
    captionStyle: caption.style,
    transcripts: mu.transcripts,
    recoveries: Object.fromEntries(input.sources.map((s) => [s.path, mu.recoveriesFor(s.path)])),
    origin,
  });
  if ('error' in body) return { id: p.id, ok: false, error: body.error };
  let hash: string;
  try {
    hash = await invoke<string>('chroma_clipper_content_hash', { timeline: body.timeline });
  } catch (e: unknown) {
    return { id: p.id, ok: false, error: `could not fingerprint the short: ${message(e)}` };
  }
  const timeline: Timeline = { ...body.timeline, origin: { ...origin, built_content_hash: hash } };
  try {
    if (body.gradePairs.length > 0) await invoke('chroma_clipper_copy_grades', { pairs: body.gradePairs });
    if (useEditorTimelineStore.getState().timeline?.id === timeline.id) {
      useEditorTimelineStore.getState().applyOp({
        kind: 'replace_timeline_body',
        tracks: timeline.tracks,
        markers: timeline.markers ?? [],
        output: timeline.output ?? null,
        origin: timeline.origin ?? null,
      });
    } else {
      await invoke('chroma_timeline_replace', { id: timeline.id, timeline });
    }
  } catch (e: unknown) {
    return { id: p.id, ok: false, error: `the short could not be written: ${message(e)}` };
  }
  return {
    id: p.id,
    ok: true,
    timelineId: timeline.id,
    name: timeline.name,
    seconds: Math.round(resolved.tight_secs * 10) / 10,
    captions: body.captions,
    tightened: body.tightened.filter((r) => r.applied).length,
    warnings: [...body.warnings, ...caption.notes],
  };
}

/** `editor_build_clips`: build the named proposals (default: every accepted
 *  or pending one that passes the gate and is not built), optionally queue
 *  their exports. */
export async function buildClips(a: OpArgs) {
  const run = runOf(a);
  if ('error' in run) return run;
  const mode = (a?.mode ?? 'refuse') as RebuildMode;
  if (mode !== 'refuse' && mode !== 'replace' && mode !== 'new_version') return { error: 'mode must be "refuse" (default), "replace" or "new_version"' };
  const rebuild = !!a?.rebuild || mode !== 'refuse';
  const ids = Array.isArray(a?.ids) ? a.ids.filter((x): x is string => typeof x === 'string') : null;
  const chosen = ids
    ? ids.map((id) => run.proposals.find((p) => p.id === id) ?? id)
    : run.proposals.filter((p) => p.status !== 'rejected' && p.verdict.verdict !== 'refused' && (rebuild || p.status !== 'built'));
  const unknown = chosen.filter((x): x is string => typeof x === 'string');
  if (unknown.length > 0) return { error: `no proposal ${unknown.join(', ')} in run ${run.id}` };
  const input = await resolveView(run);
  if ('error' in input) return input;
  if (input.pending.length > 0 || input.provisional) return { error: 'the source is still being transcribed; building waits for the whole transcript' };
  const analysed = await analyseRun(run);
  if ('error' in analysed) return analysed;
  if ('pending' in analysed) return { error: 'the source has no words to build from yet' };
  const viewId = analysed.wire.viewId;

  const results: Array<Awaited<ReturnType<typeof buildOne>>> = [];
  let current = run;
  for (const p of chosen as ClipProposal[]) {
    const r = await buildOne(current, p, input, viewId, mode, rebuild);
    results.push(r);
    if (r.ok && !r.skipped) {
      current = {
        ...current,
        proposals: current.proposals.map((x) => (x.id === p.id ? { ...x, status: 'built' as const, timeline_id: r.timelineId, built_at: new Date().toISOString() } : x)),
      };
      const saved = await useClipperStore.getState().saveRun(current);
      if ('error' in saved) return saved;
    }
  }
  await useEditorTimelineStore.getState().loadList();

  const exports: Array<{ id: string; jobId?: string; outPath?: string; error?: string }> = [];
  if (typeof a?.exportDir === 'string' && a.exportDir) {
    for (const r of results) {
      if (!r.ok) continue;
      const outPath = `${a.exportDir.replace(/\/+$/, '')}/${r.name.replace(/[^\p{L}\p{N} _.-]+/gu, '').trim() || r.id}.mp4`;
      const args = { timelineId: r.timelineId, outPath, ...(typeof a.loudnessPreset === 'string' ? { loudnessPreset: a.loudnessPreset } : {}) };
      const prepared = await prepareEditorExport(args);
      if ('error' in prepared) {
        exports.push({ id: r.id, error: prepared.error });
        continue;
      }
      const job = useExportQueueStore.getState().enqueue(r.name, args, prepared.timeline);
      exports.push('error' in job ? { id: r.id, error: job.error } : { id: r.id, jobId: job.id, outPath });
    }
  }
  return {
    ok: results.every((r) => r.ok),
    runId: run.id,
    results,
    ...(exports.length > 0 ? { exports, exportNote: 'queued in the Export queue, one after another; poll editor_export_status' } : {}),
  };
}
