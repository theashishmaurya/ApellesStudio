/**
 * @chroma/editor — the Edit tab's **Import subtitles** action (D-228,
 * `docs/notes/subtitles.md`).
 *
 * **Why this exists as its own button rather than falling out of the media
 * pool.** A `.srt` is not media: it has no picture, no sound and no duration
 * of its own, and dropping one into the Sources panel would put a non-decodable
 * file into a pool whose every other member is probed with `ffprobe`. It
 * becomes a whole TRACK, not a clip, so it needs its own verb — which is also
 * how the reference NLE exposes it (a File ▸ Import ▸ Subtitle action, not a
 * media import).
 *
 * **The GUI half of `editor_import_subtitles`** (CLAUDE.md: every feature is
 * built for a human AND an AI). Both go through the same
 * `chroma_import_subtitles` command for the parse and the ms→frames
 * conversion, and the same `import_subtitles` store op to place the track —
 * one parser, one rounding rule, one undo entry, whichever interface asked.
 */
import { useState } from 'react';
import { open } from '@tauri-apps/plugin-dialog';
import { invoke } from '@tauri-apps/api/core';
import { Captions } from 'lucide-react';
import { Button } from '@chroma/ui';

import { useEditorTimelineStore } from './timelineStore';

/** One cue as `chroma_import_subtitles` returns it — already parsed and
 *  already on the project's own timebase. Mirrors
 *  `chroma::subtitles::ImportedCaption`. */
interface ImportedCaption {
  id: string;
  start_frame: number;
  duration: number;
  text: string;
}

export function SubtitleImportButton() {
  const timeline = useEditorTimelineStore((s) => s.timeline);
  const applyOp = useEditorTimelineStore((s) => s.applyOp);
  const playhead = useEditorTimelineStore((s) => s.playhead);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const importFile = async () => {
    setError(null);
    // The filter names only what the backend will actually accept — offering
    // `.ttml` here and refusing it after the picker would be a worse
    // experience than not offering it (D-228 §4 on why TTML is refused).
    const picked = await open({
      multiple: false,
      filters: [{ name: 'Subtitles', extensions: ['srt', 'vtt'] }],
    });
    if (typeof picked !== 'string') return;

    // Dropped at the playhead, not at 00:00 — what every reference NLE does
    // when you import into the middle of an edit. A playhead at 0 (the common
    // case) makes this a no-op.
    //
    // Computed BEFORE the `try`, deliberately: the React Compiler bails out of
    // a whole function containing a conditional "value block" inside a
    // try/catch, and D-201 keeps this package at zero bailouts (enforced by
    // `reactCompiler.test.ts`).
    const offsetFrames = playhead > 0 ? playhead : null;
    setBusy(true);
    let res: { cues: ImportedCaption[]; source_name: string } | null = null;
    try {
      res = await invoke<{ cues: ImportedCaption[]; source_name: string }>(
        'chroma_import_subtitles',
        { path: picked, offsetFrames },
      );
    } catch (e) {
      // The backend's message is written to be read by a human as well as an
      // agent (it names the offending line for a malformed file, and names
      // TTML explicitly for an unsupported one), so it is surfaced verbatim
      // rather than replaced with a generic failure.
      setError(String(e));
    }
    setBusy(false);
    if (!res) return;
    if (res.cues.length === 0) {
      setError('That file contained no cues.');
      return;
    }
    // ONE op for the whole file: a 400-cue `.srt` is one undo entry, not four
    // hundred. See the op's own doc in `timeline.ts`.
    applyOp({ kind: 'import_subtitles', cues: res.cues });
  };

  return (
    <div className="flex items-center gap-2">
      <Button
        variant="ghost"
        size="xs"
        disabled={busy || !timeline}
        onClick={importFile}
        title="Import subtitles (.srt, .vtt) as a new subtitle track"
      >
        <Captions className="size-3.5" />
        <span className="ml-1">{busy ? 'Importing…' : 'Subtitles'}</span>
      </Button>
      {error && (
        <span className="truncate text-[11px] text-red-400" title={error}>
          {error}
        </span>
      )}
    </div>
  );
}
