/**
 * `@apelles/editor` — edit by text in the Index panel's transcript: pick words,
 * Delete cuts them; fillers highlighted for one-click review (D-420, roadmap 0l).
 *
 * **What it is.** The selection state, the filler highlight and the cut action
 * the Transcript view (`EditIndexPanel.tsx`) renders, plus the small bar above
 * the transcript that carries them. The words come from the same
 * `stitchTimelineTranscript` rows the view draws; the cut is
 * `cutPickedWords` (`cutWordsOps.ts`) — the planner and the one
 * `ripple_delete_ranges` op `editor_cut_words` runs, so a person's Delete and
 * an agent's call cut the same frames.
 *
 * **The interaction** (Descript's text editing, kept to the gestures this panel
 * already has): a plain click on a word still seeks there and marks it as the
 * anchor; ⇧-click selects from the anchor to that word; ⌘/Ctrl-click adds or
 * removes one word; Delete or Backspace (focus in the transcript) or the bar's
 * Delete button cuts the selection as one undo step; Esc clears it. "Fillers"
 * turns the highlight on ("uh"/"um", stutters and repeats solid; "like"/"okay"
 * dotted, because they are only sometimes filler), and "Select fillers" picks
 * the solid ones for review — deselect any that should stay, then Delete.
 *
 * **What it does NOT do.** It does not cut on its own: every cut is a person's
 * Delete. A selection is tied to the rows it was made on; any edit or newly
 * landed transcript (new rows) drops it rather than let indices point at other
 * words.
 */

import { useMemo, useState } from 'react';
import { Button } from '@apelles/ui';

import { cutPickedWords } from './cutWordsOps';
import { findFillers, type FillerKind } from './fillers';
import { useEditorTimelineStore } from './timelineStore';
import type { TimelineTranscriptRow } from './timelineTranscript';

/** What a filler mark means, for a word's tooltip. */
export const FILLER_LABEL: Readonly<Record<FillerKind, string>> = {
  filler: 'Filler',
  maybe: 'Maybe a filler',
  stutter: 'Stutter (a cut-off start)',
  repeat: 'Repeated word',
};

const NO_WORDS: ReadonlySet<number> = new Set();

export interface WordEditing {
  /** Words in the whole transcript. */
  wordCount: number;
  /** Index of each row's first word in the whole transcript's word list. */
  firstWordOfRow: readonly number[];
  selected: ReadonlySet<number>;
  selectedCount: number;
  fillerKinds: ReadonlyMap<number, FillerKind>;
  /** Fillers solid enough to select in one click (not `maybe`). */
  definiteFillers: number;
  showFillers: boolean;
  setShowFillers: (on: boolean) => void;
  pick: (word: number, mode: 'seek' | 'extend' | 'toggle') => void;
  selectFillers: () => void;
  clear: () => void;
  cutSelected: () => Promise<void>;
  busy: boolean;
  notice: { ok: boolean; text: string } | null;
}

export function useWordEditing(rows: readonly TimelineTranscriptRow[]): WordEditing {
  const { flat, firstWordOfRow } = useMemo(() => {
    const words: Array<{ row: TimelineTranscriptRow; text: string; sourceStart: number; sourceEnd: number }> = [];
    const firsts: number[] = [];
    for (const row of rows) {
      firsts.push(words.length);
      for (const w of row.words) words.push({ row, text: w.text, sourceStart: w.sourceStart, sourceEnd: w.sourceEnd });
    }
    return { flat: words, firstWordOfRow: firsts };
  }, [rows]);
  const fillerKinds = useMemo(
    () => new Map(findFillers(flat.map((w) => ({ text: w.text }))).map((f) => [f.index, f.kind] as const)),
    [flat],
  );
  const definiteFillers = useMemo(
    () => [...fillerKinds.values()].filter((k) => k !== 'maybe').length,
    [fillerKinds],
  );

  // The selection and the anchor remember which rows they were made on; on
  // new rows they read as empty (no effect needed to reset them).
  const [selection, setSelection] = useState<{ rows: readonly TimelineTranscriptRow[]; words: ReadonlySet<number> }>({
    rows,
    words: NO_WORDS,
  });
  const [anchor, setAnchor] = useState<{ rows: readonly TimelineTranscriptRow[]; word: number } | null>(null);
  const [showFillers, setShowFillers] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null);
  const selected = selection.rows === rows ? selection.words : NO_WORDS;
  const anchorWord = anchor && anchor.rows === rows ? anchor.word : null;

  const pick = (word: number, mode: 'seek' | 'extend' | 'toggle') => {
    setNotice(null);
    if (mode === 'seek') {
      setAnchor({ rows, word });
      setSelection({ rows, words: NO_WORDS });
      return;
    }
    if (mode === 'extend') {
      const from = anchorWord ?? word;
      const next = new Set<number>();
      for (let i = Math.min(from, word); i <= Math.max(from, word); i += 1) next.add(i);
      setSelection({ rows, words: next });
      if (anchorWord === null) setAnchor({ rows, word });
      return;
    }
    const next = new Set(selected);
    if (next.has(word)) next.delete(word);
    else next.add(word);
    setSelection({ rows, words: next });
    setAnchor({ rows, word });
  };

  const selectFillers = () => {
    setShowFillers(true);
    setNotice(null);
    setSelection({
      rows,
      words: new Set([...fillerKinds].filter(([, k]) => k !== 'maybe').map(([i]) => i)),
    });
  };

  const clear = () => setSelection({ rows, words: NO_WORDS });

  const cutSelected = async () => {
    const tl = useEditorTimelineStore.getState().timeline;
    if (!tl || selected.size === 0 || busy) return;
    const picked = [...selected].map((i) => flat[i]).filter(Boolean);
    const tracks = [...new Set(picked.map((w) => w.row.track))];
    if (tracks.length !== 1) {
      setNotice({ ok: false, text: 'Select words from one track at a time — these come from several.' });
      return;
    }
    setBusy(true);
    const result = await cutPickedWords(
      tl,
      tracks[0],
      picked.map((w) => ({ clipId: w.row.clipId, sourceStart: w.sourceStart, sourceEnd: w.sourceEnd })),
    ).catch((e: unknown) => ({ error: e instanceof Error ? e.message : String(e) }));
    setBusy(false);
    if ('error' in result && result.error) {
      setNotice({ ok: false, text: String(result.error) });
      return;
    }
    const words = 'deletedWords' in result ? result.deletedWords : selected.size;
    const secs = 'cutSecs' in result ? result.cutSecs : 0;
    const tight = 'tight' in result && result.tight ? ` ${result.tight.length} sat under a frame from a kept word — listen there.` : '';
    setNotice({
      ok: true,
      text: `Cut ${words} word${words === 1 ? '' : 's'} (${secs.toFixed(2)}s) — one undo reverses it.${tight}`,
    });
    setSelection({ rows, words: NO_WORDS });
  };

  return {
    wordCount: flat.length,
    firstWordOfRow,
    selected,
    selectedCount: selected.size,
    fillerKinds,
    definiteFillers,
    showFillers,
    setShowFillers,
    pick,
    selectFillers,
    clear,
    cutSelected,
    busy,
    notice,
  };
}

/** The bar above the transcript: the filler highlight, the selection, the cut. */
export function WordEditBar({ edit }: { edit: WordEditing }) {
  return (
    <div data-chroma-transcript-edit-bar className="flex flex-col gap-1 rounded-md border border-border-color bg-bg-primary p-1.5">
      <div className="flex flex-wrap items-center gap-1.5">
        <Button
          size="xs"
          variant={edit.showFillers ? 'default' : 'outline'}
          aria-pressed={edit.showFillers}
          data-chroma-transcript-fillers-toggle
          className="h-6 px-2 text-[11px]"
          onClick={() => edit.setShowFillers(!edit.showFillers)}
          title="Highlight fillers (uh, um), stutters and repeated words; like / okay dotted"
        >
          Fillers {edit.fillerKinds.size}
        </Button>
        {edit.definiteFillers > 0 ? (
          <Button
            size="xs"
            variant="outline"
            data-chroma-transcript-select-fillers
            className="h-6 px-2 text-[11px]"
            onClick={edit.selectFillers}
            title="Select every uh/um, stutter and repeat for review — deselect any to keep (⌘-click), then Delete"
          >
            Select fillers
          </Button>
        ) : null}
        {edit.selectedCount > 0 ? (
          <>
            <span data-chroma-transcript-selected-count className="ml-auto text-[11px] tabular-nums text-text-secondary">
              {edit.selectedCount} selected
            </span>
            <Button
              size="xs"
              variant="destructive"
              data-chroma-transcript-cut
              className="h-6 px-2 text-[11px]"
              disabled={edit.busy}
              onClick={() => void edit.cutSelected()}
              title="Cut the selected words from the timeline (Delete) — one undo step"
            >
              Delete
            </Button>
            <Button size="xs" variant="ghost" className="h-6 px-2 text-[11px]" onClick={edit.clear}>
              Clear
            </Button>
          </>
        ) : (
          <span className="ml-auto text-[10px] text-text-secondary">⇧/⌘-click words to select</span>
        )}
      </div>
      {edit.notice ? (
        <p
          data-chroma-transcript-edit-notice
          className={`text-[10px] leading-snug ${edit.notice.ok ? 'text-text-secondary' : 'text-destructive'}`}
        >
          {edit.notice.text}
        </p>
      ) : null}
    </div>
  );
}
