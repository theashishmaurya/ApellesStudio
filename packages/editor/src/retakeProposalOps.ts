/**
 * `@apelles/editor` — the three `editor_*` ops an MCP client loops over to
 * propose retakes (D-380 step 2).
 *
 * **What it is.** The stateful half of the client-judged retake flow, called
 * from `useEditorControl`'s op registry:
 *
 * - `editor_get_word_transcript` — a page of the track's word-indexed view, its
 *   `viewId`, and (on the first page) the instructions the client judges by;
 * - `editor_propose_retakes` — the client's groups through the coverage gate,
 *   stored for the Recut panel, answered with each group's status;
 * - `editor_retranscribe_words` — a fresh, isolated speech-recogniser reading
 *   of a stretch of words, and (on `apply`) that reading spliced into the
 *   file's transcript for every consumer.
 *
 * **The loop is the CLIENT's.** The app runs no model and makes no judgement
 * here: it renders words, runs a deterministic gate, re-runs the ASR it
 * already runs, and stores what the client decided. Which stretches are
 * retakes, whether a refused word was misheard, whether to confirm — all of
 * that is the MCP client reading these answers.
 *
 * **What it does NOT do.** Nothing is cut. Applying a proposal is
 * `editor_ripple_delete_ranges` (the agent, when the user asks) or the Recut
 * panel's Cut (the human) — the same store op either way.
 */

import { invoke } from '@tauri-apps/api/core';

import { recoveryKey, useMediaUnderstandingStore } from './mediaUnderstandingStore';
import {
  buildWordViewInput,
  rereadWindow,
  viewBasisKey,
  viewWordsInWindow,
  wireViewArgs,
  type ViewWord,
  type WordViewInput,
} from './retakeWordView';
import {
  groupDto,
  parseClientGroups,
  retakeInstructions,
  reviewGroups,
  wireGroups,
  type CheckWire,
} from './retakeProposals';
import { DETECT_GRACE_MS, settleWithin } from './settle';
import type { Timeline } from './timeline';

type OpArgs = Record<string, unknown> | undefined;

/** `chroma_retake_word_view`'s answer. */
interface ViewWire {
  viewId: string;
  totalWords: number;
  offset: number;
  returned: number;
  nextOffset: number | null;
  text: string;
  rules?: string;
  words?: ViewWord[];
}

/** The track's view input, or why there is none yet. `start` kicks a
 *  transcription for every source that has none — one per FILE. */
function resolveInput(
  tl: Timeline,
  a: OpArgs,
  start: boolean,
): { input: WordViewInput } | { error: string } | { pending: Record<string, unknown> } {
  const track = Math.round(Number(a?.track));
  if (!Number.isFinite(track)) return { error: 'track must be a track index' };
  const read = () => {
    const s = useMediaUnderstandingStore.getState();
    return buildWordViewInput(tl, track, s.transcripts, s.recoveriesFor, s.transcriptErrors);
  };
  let input = read();
  if ('error' in input) return input;
  if (start && (input.pending.length > 0 || input.failed.length > 0)) {
    const store = useMediaUnderstandingStore.getState();
    for (const path of [...input.pending, ...input.failed.map((f) => f.path)]) {
      store.startTranscript(path, { wordTimestamps: true });
    }
    input = read();
    if ('error' in input) return input;
  }
  if (input.pending.length > 0) {
    // B-250 — what to do next depends on whether a transcription is actually
    // RUNNING for each file, not on whether this call started it: another
    // caller (the Index panel, a retake sweep, an earlier `start: true`) may
    // already have one going, and telling the agent to start it again is wrong.
    const transcribing = useMediaUnderstandingStore.getState().transcribing;
    const notRunning = input.pending.filter((path) => !transcribing[path]).length;
    return {
      pending: {
        ok: true,
        track,
        state: 'transcribing',
        pending: input.pending,
        note:
          `${input.pending.length} source file(s) on this track have no transcript yet — the word view is ` +
          'only served whole, because word indices would shift when they land. ' +
          (notRunning === 0
            ? 'Transcription is running; call this again in a few seconds.'
            : notRunning === input.pending.length
              ? 'Call editor_get_word_transcript with start: true to transcribe them.'
              : `${input.pending.length - notRunning} are being transcribed already; call ` +
                `editor_get_word_transcript with start: true to transcribe the other ${notRunning}.`),
      },
    };
  }
  if (input.failed.length > 0) {
    return {
      error:
        `transcription failed for ${input.failed.map((f) => f.path).join(', ')}: ${input.failed[0].error}. ` +
        'Call editor_get_word_transcript with start: true to retry.',
    };
  }
  return { input };
}

async function viewOf(
  input: WordViewInput,
  offset: number,
  maxWords: number | null,
  includeWords: boolean,
): Promise<ViewWire> {
  return invoke<ViewWire>('chroma_retake_word_view', {
    ...wireViewArgs(input),
    offset,
    maxWords,
    includeWords,
  });
}

const staleError = (current: string) =>
  `stale view_id: this track's words changed since you read them (an edit, a finished transcript, ` +
  `or an applied re-read) — the current view is ${current}. Re-read with editor_get_word_transcript, ` +
  're-derive your word indices, and resubmit. Nothing was changed.';

/** `editor_get_word_transcript`. */
export async function getWordTranscript(tl: Timeline, a: OpArgs) {
  const resolved = resolveInput(tl, a, !!a?.start);
  if ('error' in resolved) return resolved;
  if ('pending' in resolved) return resolved.pending;
  const { input } = resolved;
  if (input.pieces.length === 0) {
    return { ok: true, track: input.track, state: 'done', totalWords: 0, note: 'no clips with audio on this track' };
  }
  const offset = a?.offset === undefined || a?.offset === null ? 0 : Math.round(Number(a.offset));
  if (!Number.isFinite(offset) || offset < 0) return { error: 'offset must be a non-negative word index' };
  const maxWords = a?.maxWords === undefined || a?.maxWords === null ? null : Math.round(Number(a.maxWords));
  if (maxWords !== null && (!Number.isFinite(maxWords) || maxWords < 1)) {
    return { error: 'maxWords must be a positive number of words' };
  }
  const v = await viewOf(input, offset, maxWords, false);
  return {
    ok: true,
    track: input.track,
    state: 'done',
    viewId: v.viewId,
    totalWords: v.totalWords,
    offset: v.offset,
    returned: v.returned,
    nextOffset: v.nextOffset,
    clips: input.pieces.length,
    sources: input.sources.map((s) => s.path),
    ...(v.rules ? { instructions: retakeInstructions(v.rules) } : {}),
    text: v.text,
    note:
      v.nextOffset === null
        ? 'that is the whole view — propose with editor_propose_retakes and this viewId'
        : `more words follow — call again with offset: ${v.nextOffset} (same viewId while the track is unchanged)`,
  };
}

/** `editor_propose_retakes`. */
export async function proposeRetakes(tl: Timeline, a: OpArgs) {
  const resolved = resolveInput(tl, a, false);
  if ('error' in resolved) return resolved;
  if ('pending' in resolved) {
    return { error: 'this track still has sources being transcribed — read it with editor_get_word_transcript first' };
  }
  const { input } = resolved;
  const groups = parseClientGroups(a?.groups);
  if ('error' in groups) return groups;
  const store = useMediaUnderstandingStore.getState();
  if (groups.length === 0) {
    store.setRetakeProposals(input.track, null);
    return { ok: true, track: input.track, cleared: true, note: 'this track has no client proposals now' };
  }
  const viewId = typeof a?.viewId === 'string' ? a.viewId : '';
  if (!viewId) return { error: 'view_id is required — the viewId editor_get_word_transcript returned' };

  const checked = await invoke<CheckWire>('chroma_check_retake_proposals', {
    ...wireViewArgs(input),
    viewId,
    groups: wireGroups(groups),
  });
  if (checked.stale) return { error: staleError(checked.viewId), viewId: checked.viewId };

  const reviewed = reviewGroups(input, checked.words, groups, checked.verdicts);
  store.setRetakeProposals(input.track, {
    track: input.track,
    viewId: checked.viewId,
    basisKey: viewBasisKey(input),
    receivedAt: Date.now(),
    groups: reviewed,
  });
  const count = (s: string) => reviewed.filter((g) => g.status === s).length;
  const refused = count('refused');
  return {
    ok: true,
    track: input.track,
    viewId: checked.viewId,
    verified: count('verified'),
    aiConfirmed: count('ai_confirmed'),
    refused,
    groups: reviewed.map(groupDto),
    note:
      (refused > 0
        ? `${refused} group(s) refused — for each: narrow the take, re-transcribe the offending words ` +
          '(editor_retranscribe_words), confirm them with a per-word reason, or drop the group; then resubmit ' +
          'EVERY group you still want (this call replaces the set). '
        : '') +
      'Nothing was cut. The proposals are in the Recut panel for the person to review; cut with ' +
      'editor_ripple_delete_ranges only if they ask you to.',
  };
}

/** Lower-case word tokens, punctuation dropped — "is this the same reading". */
function tokens(ws: ReadonlyArray<{ word: string }>): string {
  return ws
    .map((w) => w.word.toLowerCase().replace(/[^\p{L}\p{N}']+/gu, ''))
    .filter(Boolean)
    .join(' ');
}

/** `editor_retranscribe_words`. */
export async function retranscribeWords(tl: Timeline, a: OpArgs) {
  const resolved = resolveInput(tl, a, false);
  if ('error' in resolved) return resolved;
  if ('pending' in resolved) {
    return { error: 'this track still has sources being transcribed — read it with editor_get_word_transcript first' };
  }
  const { input } = resolved;
  const viewId = typeof a?.viewId === 'string' ? a.viewId : '';
  if (!viewId) return { error: 'view_id is required — the viewId your word indices were read under' };
  const first = Number(a?.first);
  const last = Number(a?.last);

  const v = await viewOf(input, 0, 1, true);
  if (v.viewId !== viewId) return { error: staleError(v.viewId), viewId: v.viewId };
  const words = v.words ?? [];
  const win = rereadWindow(input, words, first, last);
  if ('error' in win) return win;
  const window = { startSecs: win.startSecs, durationSecs: win.durationSecs };
  const endSecs = win.startSecs + win.durationSecs;
  const key = recoveryKey(win.path, window);

  useMediaUnderstandingStore.getState().startReread(win.path, window, win.language, !!a?.force);
  const status = await settleWithin(
    () => useMediaUnderstandingStore.getState().rereadStatus(key),
    DETECT_GRACE_MS,
  );
  const head = {
    ok: true as const,
    track: input.track,
    viewId,
    source: win.path,
    window: { startSecs: win.startSecs, endSecs },
  };
  if (status.phase === 'error') return { error: status.error ?? 're-transcription failed' };
  if (status.phase !== 'done' || !status.result) {
    return {
      ...head,
      state: 'running',
      note: 'still re-transcribing — call again with the same arguments to collect it',
    };
  }

  const current = viewWordsInWindow(input, words, win.path, win.startSecs, endSecs);
  const reread = status.result.segments
    .flatMap((s) => s.words ?? [])
    .map((w) => ({ word: w.word.trim(), start: w.start, end: w.end }));
  // Compare against the SOURCE's words in the window, not only the visible
  // ones: the re-read hears the audio either side of a clip too.
  const sourceWords = (input.sources.find((s) => s.path === win.path)?.segments ?? [])
    .flatMap((s) => s.words ?? [])
    .filter((w) => {
      const mid = (w.start + w.end) / 2;
      return mid >= win.startSecs && mid < endSecs;
    });
  const identical = tokens(sourceWords) === tokens(reread);
  const result = {
    ...head,
    state: 'done',
    current: current.map((w) => ({ index: w.index, word: w.word.trim(), start: w.start, end: w.end })),
    reread,
    identical,
  };
  if (!a?.apply) {
    return {
      ...result,
      applied: false,
      note: identical
        ? 'the re-read hears the same words — the gate was not refusing a mishearing here'
        : 'nothing changed yet. If the re-read is the better reading, call again with apply: true — it then ' +
          'replaces these words in the transcript for every consumer and the viewId changes.',
    };
  }
  if (identical) {
    return { ...result, applied: false, note: 'the re-read hears the same words; there is nothing to apply' };
  }
  useMediaUnderstandingStore.getState().applyReread(key);

  const after = resolveInput(tl, a, false);
  if (!('input' in after)) return { ...result, applied: true, note: 'applied; re-read the track before proposing' };
  const nv = await viewOf(after.input, 0, 1, true);
  const now = viewWordsInWindow(after.input, nv.words ?? [], win.path, win.startSecs, endSecs);
  return {
    ...result,
    applied: true,
    previousViewId: viewId,
    viewId: nv.viewId,
    // Every word after the window moved by this many indices.
    indexShift: now.length - current.length,
    words: now.map((w) => ({ index: w.index, word: w.word.trim(), start: w.start, end: w.end })),
    note:
      'applied: the transcript now holds the re-read for this stretch, for every consumer, and the viewId ' +
      'changed. Re-derive any indices you hold (words after the window moved by indexShift) or re-read the ' +
      'page, then resubmit your groups with the new viewId.',
  };
}
