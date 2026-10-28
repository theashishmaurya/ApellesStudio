/**
 * `@apelles/editor` — `editor_cut_words`: delete word ranges of a track's word
 * view, as ONE undo step (D-420, roadmap 0l).
 *
 * **What it is.** The stateful half of edit-by-text. It reads the track's word
 * view (the one `editor_get_word_transcript` serves, through the same
 * `resolveWordViewInput` / `readWordView`), checks the caller's `viewId`, plans
 * the cuts with `planCutWords` (`cutWords.ts`, pure, tested) and applies them as
 * one `ripple_delete_ranges` op — the D-318 op the Recut panel's Cut button and
 * `editor_ripple_delete_ranges` already use, which carries A/V-linked partners
 * (D-129) and sync-locked tracks (D-106) with it. The Index panel's
 * transcript (select words, Delete) calls [`cutWords`] too, so a person and an
 * agent cut identically.
 *
 * **The answer says exactly what was cut**: each cut's frames as they were
 * before the edit, the words it removed (index and text) or `gap` for a
 * tightened pause, the per-range outcome of the ripple (B-197: a batch answers
 * per range, never one boolean), and the new `viewId` — every index after the
 * first cut has moved.
 *
 * **What it does NOT do.** It does not judge what to cut (the person or the MCP
 * client does; `fillers.ts` only suggests), and it never cuts on a stale view.
 */

import {
  readWordView,
  resolveWordViewInput,
  staleWordViewError,
} from './retakeProposalOps';
import { planCutWords, rangesOf, viewIndicesOf, type CutWordsPlan, type WordPick, type WordRange } from './cutWords';
import { wordsText, type ViewWord } from './retakeWordView';
import { applyRippleDeleteRanges, timelineFps, type Timeline } from './timeline';
import { useEditorTimelineStore } from './timelineStore';

type OpArgs = Record<string, unknown> | undefined;

/** What [`cutWords`] needs, already parsed. */
export interface CutWordsRequest {
  track: number;
  /** The view the indices were read under; `null` for "the current view" (the
   *  panel, which reads and cuts in one gesture). */
  viewId: string | null;
  ranges: WordRange[];
  tightenGapsMs?: number | null;
  keepBreathMs?: number;
  dryRun?: boolean;
}

/** An optional millisecond argument: `undefined` when absent, `NaN` when not a
 *  number (refused by the caller). */
function optionalMs(v: unknown): number | undefined {
  if (v === undefined || v === null) return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : Number.NaN;
}

/** The answer's description of one plan, shared by a dry run and a cut. */
function describe(plan: CutWordsPlan, words: readonly ViewWord[]) {
  return plan.cuts.map((c) => ({
    clip: c.clip,
    clipId: c.clipId,
    startFrame: c.startFrame,
    endFrame: c.endFrame,
    frames: c.endFrame - c.startFrame,
    sourceStartSecs: c.startSecs,
    sourceEndSecs: c.endSecs,
    kind: c.kind,
    ...(c.words.length
      ? {
          words: c.words.map((i) => ({ index: i, word: words[i]?.text.trim() ?? '' })),
          text: wordsText(words, c.words[0], c.words[c.words.length - 1]),
        }
      : {}),
  }));
}

/**
 * Plan and (unless `dryRun`) apply a word cut. Returns the MCP answer shape;
 * the panel reads the same object.
 */
export async function cutWords(tl: Timeline, req: CutWordsRequest) {
  const resolved = resolveWordViewInput(tl, { track: req.track }, false);
  if ('error' in resolved) return resolved;
  if ('pending' in resolved) {
    return { error: 'this track still has sources being transcribed — read it with editor_get_word_transcript first' };
  }
  const { input } = resolved;
  const view = await readWordView(input, 0, 1, true);
  if (req.viewId !== null && view.viewId !== req.viewId) {
    return { error: staleWordViewError(view.viewId), viewId: view.viewId };
  }
  const words = view.words ?? [];
  const tighten = req.tightenGapsMs === undefined || req.tightenGapsMs === null ? null : req.tightenGapsMs / 1000;
  const plan = planCutWords(input, words, req.ranges, {
    tightenGapsSecs: tighten,
    ...(req.keepBreathMs !== undefined ? { keepBreathSecs: req.keepBreathMs / 1000 } : {}),
  });
  if ('error' in plan) return plan;

  const cuts = describe(plan, words);
  const totalFrames = plan.cuts.reduce((n, c) => n + (c.endFrame - c.startFrame), 0);
  const fps = timelineFps(tl);
  const summary = {
    track: input.track,
    viewId: view.viewId,
    deletedWords: plan.deleted.length,
    tightenedGaps: plan.tightened,
    cutFrames: totalFrames,
    cutSecs: Math.round((totalFrames / fps) * 1000) / 1000,
    cuts,
    ...(plan.tight.length
      ? {
          tight: plan.tight.map((t) => ({ index: t.index, word: words[t.index]?.text.trim() ?? '', side: t.side })),
          tightNote:
            'these deleted words sit less than a frame from a word that stays, so the cut edge there is the middle of ' +
            'the gap — listen at them',
        }
      : {}),
    ...(plan.uncut.length ? { uncut: plan.uncut } : {}),
  };
  if (plan.cuts.length === 0) {
    return { error: 'nothing to cut — the ranges hold no word that covers a whole frame', ...summary };
  }
  if (req.dryRun) {
    return {
      ok: true as const,
      dryRun: true,
      ...summary,
      note: 'nothing was cut (dry_run) — call again without dry_run to apply these cuts as one undo step',
    };
  }

  const ranges = plan.cuts.map((c) => ({ start: c.startFrame, end: c.endFrame }));
  const dry = applyRippleDeleteRanges(tl, input.track, ranges, fps);
  const skipped = dry.results.filter((r) => !r.applied);
  if (dry.timeline === tl) {
    return {
      error: `nothing was cut — none of the ${dry.results.length} range(s) could be applied`,
      ...summary,
      skipped: skipped.map((r) => ({ startFrame: r.start, endFrame: r.end, reason: r.reason })),
    };
  }
  useEditorTimelineStore.getState().applyOp({ kind: 'ripple_delete_ranges', track: input.track, ranges });

  // The view after the cut — every index past the first cut has moved.
  const after = useEditorTimelineStore.getState().timeline;
  let viewId: string | null = null;
  if (after) {
    const next = resolveWordViewInput(after, { track: input.track }, false);
    if ('input' in next) viewId = (await readWordView(next.input, 0, 1, false)).viewId;
  }
  const head = {
    ...summary,
    previousViewId: view.viewId,
    viewId,
    applied: dry.results.length - skipped.length,
    ranges: dry.results.length,
  };
  if (skipped.length > 0) {
    return {
      ok: false as const,
      error:
        `${skipped.length} of ${dry.results.length} cut ranges were NOT applied — see \`skipped\`. The others WERE ` +
        '(one undo entry): re-read the track before acting on any index or frame you hold.',
      ...head,
      skipped: skipped.map((r) => ({ startFrame: r.start, endFrame: r.end, reason: r.reason })),
    };
  }
  return {
    ok: true as const,
    ...head,
    note:
      'cut as ONE edit (a single undo reverses all of it). The frames above are where the cuts were BEFORE the ' +
      'edit; the track is now cutFrames shorter. Re-read with editor_get_word_transcript before cutting again — ' +
      'word indices after the first cut have moved (viewId changed).',
  };
}

/**
 * The Index panel's Delete: cut the words a person picked in the transcript
 * (by clip and source span) from `track`, on the CURRENT view — the panel reads
 * and cuts in one gesture, so there is no older view to be stale against.
 */
export async function cutPickedWords(
  tl: Timeline,
  track: number,
  picks: readonly WordPick[],
  options: { tightenGapsMs?: number | null; keepBreathMs?: number } = {},
) {
  const resolved = resolveWordViewInput(tl, { track }, false);
  if ('error' in resolved) return resolved;
  if ('pending' in resolved) return { error: 'this track still has sources being transcribed' };
  const view = await readWordView(resolved.input, 0, 1, true);
  const { indices, missing } = viewIndicesOf(resolved.input, view.words ?? [], picks);
  if (missing > 0) {
    return { error: `${missing} of the selected words are no longer on track ${track + 1} — the timeline changed; select again` };
  }
  return await cutWords(tl, { track, viewId: view.viewId, ranges: rangesOf(indices), ...options });
}

/** `editor_cut_words` — parse the MCP arguments, then [`cutWords`]. */
export async function cutWordsOp(tl: Timeline, a: OpArgs) {
  const track = Math.round(Number(a?.track));
  if (!Number.isFinite(track)) return { error: 'track must be a track index' };
  const viewId = typeof a?.viewId === 'string' ? a.viewId : '';
  if (!viewId) return { error: 'view_id is required — the viewId editor_get_word_transcript returned' };
  if (!Array.isArray(a?.ranges)) return { error: 'ranges must be an array of {first, last} word indices' };
  const tighten = optionalMs(a?.tightenGapsMs);
  const breath = optionalMs(a?.keepBreathMs);
  if (Number.isNaN(tighten) || Number.isNaN(breath)) {
    return { error: 'tighten_gaps_ms and keep_breath_ms must be numbers of milliseconds' };
  }
  return await cutWords(tl, {
    track,
    viewId,
    ranges: (a.ranges as Array<Record<string, unknown>>).map((r) => ({ first: Number(r?.first), last: Number(r?.last) })),
    tightenGapsMs: tighten ?? null,
    ...(breath !== undefined ? { keepBreathMs: breath } : {}),
    dryRun: !!a?.dryRun,
  });
}
