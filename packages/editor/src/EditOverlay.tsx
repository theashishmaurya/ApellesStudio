/**
 * @apelles/editor — the edit overlay (D-239, roadmap item 27).
 *
 * **What it is.** The GUI half of the seven edit types: drag a Sources-panel
 * item anywhere and a labelled strip of seven targets appears over the preview;
 * drop on one and that edit happens. Straight off Blackmagic's own Edit page —
 * "You can drag and drop clips directly into the timeline or the timeline
 * viewer on the right, where you will see an overlay with editing options. The
 * edit overlay gives you instant access to the most popular types of edits,
 * letting you quickly choose between insert, overwrite, replace, fit to fill,
 * place on top, append at end, and ripple overwrite without having to remember
 * shortcut commands" — and off the real screenshot of it the roadmap item
 * itself names (`scratch/resolve-reference/timeline.jpg`: a vertical list of
 * seven labelled rows down the right-hand side of the viewer, the one under the
 * pointer highlighted). See D-239.
 *
 * **What it does.** Owns the drag state and nothing else. Which edit each row
 * means, in what order, is `editTypes.ts`; what each edit DOES is the `edit_in`
 * `EditOp`; whether a given one is currently possible is `checkEditIn`. This
 * file renders those three and applies the op — the same op `editor_edit_in`
 * applies, per CLAUDE.md's "the same op/store action underneath both".
 *
 * **What it does NOT do.**
 * - It does not replace the timeline's own drop (D-095/D-100), which stays
 *   exactly as it was: a positional drop that snaps to a real insertion point.
 *   Two gestures, two questions — "put it HERE" vs. "do THIS edit at the
 *   playhead" — and the reference offers both for the same reason.
 * - No keyboard shortcuts (Resolve's F9–F12) and no toolbar buttons yet — both
 *   want a source viewer with real in/out marking to be worth much, which this
 *   app does not have yet. Named as follow-ups in `docs/04-roadmap.md`.
 *
 * **Why a document-level `dragenter` rather than handlers on the pane.** The
 * strip must be able to appear over a preview that is showing a spinner or "no
 * frame" (dropping onto an empty timeline is the single most common first use),
 * and the HTML5 spec makes `dataTransfer.getData` unreadable during `dragover`
 * — only `.types` is (the same constraint `TimelinePane`'s own drop handler
 * documents). So the overlay arms itself off the MIME type alone, from one
 * listener, and reads the real payload only on drop.
 */

import { useEffect, useRef, useState, type DragEvent as ReactDragEvent } from 'react';
import {
  ChevronLast,
  Gauge,
  Layers,
  MoveHorizontal,
  Replace as ReplaceIcon,
  SeparatorVertical,
  SquareStack,
  type LucideIcon,
} from 'lucide-react';

import {
  CHROMA_MEDIA_DRAG_MIME,
  DROP_EDIT_TYPES,
  checkEditIn,
  checkEditTarget,
  editTargetIndexAt,
  linkedClipsFromDraggedMedia,
  videoTrackIndex,
  type DraggedMedia,
  type DropEditType,
} from './timeline';
import { useEditorTimelineStore } from './timelineStore';

/** Per-type icon. Lives here, not in `editTypes.ts`, because it is presentation
 *  — that module stays free of any React/lucide dependency so `timeline.ts` can
 *  import from it. */
const EDIT_TYPE_ICONS: Record<DropEditType, LucideIcon> = {
  insert: SeparatorVertical,
  overwrite: SquareStack,
  replace: ReplaceIcon,
  fit_to_fill: Gauge,
  place_on_top: Layers,
  append: ChevronLast,
  ripple_overwrite: MoveHorizontal,
};

/** How long a refused drop's reason stays on screen. Long enough to read a
 *  sentence, short enough that it never becomes furniture. */
const DROP_ERROR_MS = 6000;

/** The destination track an overlay drop targets: the selected clip's own
 *  track when there is a selection (the nearest thing this app has to
 *  Resolve's destination-track patching), else the topmost video track. */
function destinationTrack(): number {
  const { timeline, selection } = useEditorTimelineStore.getState();
  if (!timeline) return 0;
  const sel = selection[0];
  if (sel && timeline.tracks[sel.track]) return sel.track;
  return videoTrackIndex(timeline);
}

export function EditOverlay() {
  const [active, setActive] = useState(false);
  const [hover, setHover] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const errorTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Arm/disarm off the drag itself. `dragenter` is watched on `document`
  // because the strip has to exist before the pointer can reach it; `dragend`
  // (fires on the source element, bubbles) and a `drop` anywhere are the two
  // real ends of a drag, and `dragleave` to `relatedTarget === null` is the
  // pointer leaving the window entirely.
  useEffect(() => {
    const isMediaDrag = (e: DragEvent) => !!e.dataTransfer?.types.includes(CHROMA_MEDIA_DRAG_MIME);
    const arm = (e: DragEvent) => {
      if (!isMediaDrag(e)) return;
      setActive((prev) => (prev ? prev : true));
      setError((prev) => (prev === null ? prev : null));
    };
    const disarm = () => {
      setActive(false);
      setHover(null);
    };
    const onWindowLeave = (e: DragEvent) => {
      if (e.relatedTarget === null) disarm();
    };
    document.addEventListener('dragenter', arm);
    document.addEventListener('dragend', disarm);
    document.addEventListener('drop', disarm);
    document.addEventListener('dragleave', onWindowLeave);
    return () => {
      document.removeEventListener('dragenter', arm);
      document.removeEventListener('dragend', disarm);
      document.removeEventListener('drop', disarm);
      document.removeEventListener('dragleave', onWindowLeave);
    };
  }, []);

  useEffect(
    () => () => {
      if (errorTimer.current) clearTimeout(errorTimer.current);
    },
    [],
  );

  const showError = (reason: string) => {
    setError(reason);
    if (errorTimer.current) clearTimeout(errorTimer.current);
    errorTimer.current = setTimeout(() => setError(null), DROP_ERROR_MS);
  };

  // Everything a row's enabled/disabled state depends on that is knowable
  // DURING a drag — `checkEditTarget`, NOT the full `checkEditIn`. The HTML5
  // spec keeps the payload unreadable until `drop`, so the source's own length
  // is genuinely unknown here, and a stand-in clip would be actively wrong
  // rather than merely approximate: any placeholder length makes `checkEditIn`'s
  // two length-dependent refusals fire every time, which would leave Replace
  // and Fit to Fill permanently greyed out and unable to accept a drop at all.
  // Those two refusals are reported after the fact instead, by `showError`,
  // with `checkEditIn`'s own sentence.
  const probeDisabled = (type: DropEditType): string | null => {
    const { timeline, playhead } = useEditorTimelineStore.getState();
    if (!timeline) return 'open a timeline first';
    const check = checkEditTarget(timeline, type, destinationTrack(), playhead);
    return check.ok ? null : (check.reason ?? 'not available here');
  };

  const onDragOver = (e: ReactDragEvent) => {
    if (!e.dataTransfer.types.includes(CHROMA_MEDIA_DRAG_MIME)) return;
    const rect = listRef.current?.getBoundingClientRect();
    if (!rect) return;
    const index = editTargetIndexAt(rect, e.clientY);
    if (probeDisabled(DROP_EDIT_TYPES[index].type)) {
      // Not a legal drop: leave `preventDefault` unsaid so the browser refuses
      // it outright rather than letting a click-through land a silent no-op.
      setHover(index);
      return;
    }
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    setHover((prev) => (prev === index ? prev : index));
  };

  const onDrop = (e: ReactDragEvent) => {
    const raw = e.dataTransfer.getData(CHROMA_MEDIA_DRAG_MIME);
    setActive(false);
    setHover(null);
    if (!raw) return;
    e.preventDefault();
    e.stopPropagation();
    let media: DraggedMedia;
    try {
      media = JSON.parse(raw);
    } catch {
      return;
    }
    const pair = linkedClipsFromDraggedMedia(media);
    if (!pair) {
      showError(`${media.name} has no known length yet — it is offline or still being probed`);
      return;
    }
    const rect = listRef.current?.getBoundingClientRect();
    const editType = DROP_EDIT_TYPES[rect ? editTargetIndexAt(rect, e.clientY) : 0].type;
    const { timeline, playhead, applyOp } = useEditorTimelineStore.getState();
    if (!timeline) return;
    const op = {
      kind: 'edit_in' as const,
      editType,
      track: destinationTrack(),
      clip: pair.video,
      atFrame: playhead,
      linkedAudio: pair.audio ?? undefined,
    };
    // The same check the rows grey out on, run once more with the REAL source:
    // this is where a too-short Replace or an out-of-range Fit to Fill is
    // caught, and it is the only place it can be (see `probeDisabled`).
    const check = checkEditIn(timeline, op);
    if (!check.ok) {
      showError(check.reason ?? 'that edit is not possible here');
      return;
    }
    applyOp(op);
  };

  if (!active) {
    return error ? (
      <div className="pointer-events-none absolute inset-x-0 bottom-16 z-30 flex justify-center">
        <div className="max-w-[80%] rounded-md border border-border-color bg-surface px-3 py-2 text-xs text-sensitive shadow-lg">
          {error}
        </div>
      </div>
    ) : null;
  }

  return (
    <div className="pointer-events-none absolute inset-0 z-30" data-edit-overlay>
      {/* The scrim is presentation only — it must never become the drop
          target, or a drop two pixels off the strip would read as a hit. */}
      <div className="absolute inset-0 bg-black/40" />
      <div
        ref={listRef}
        data-edit-overlay-list
        onDragOver={onDragOver}
        onDragLeave={() => setHover(null)}
        onDrop={onDrop}
        className="pointer-events-auto absolute top-1/2 right-3 flex w-56 -translate-y-1/2 flex-col overflow-hidden rounded-md border border-border-color bg-surface shadow-xl"
      >
        {DROP_EDIT_TYPES.map((info, i) => {
          const Icon = EDIT_TYPE_ICONS[info.type];
          const disabled = probeDisabled(info.type);
          const hovered = hover === i;
          return (
            <div
              key={info.type}
              data-edit-target={info.type}
              data-active={hovered ? 'true' : undefined}
              aria-disabled={disabled ? true : undefined}
              title={disabled ?? info.blurb}
              className={[
                'flex items-center gap-2 px-3 py-2 text-xs',
                disabled
                  ? 'text-text-secondary opacity-40'
                  : hovered
                    ? 'bg-accent text-button-text'
                    : 'text-text-primary',
              ].join(' ')}
            >
              <Icon className="size-4 shrink-0" />
              <span className="truncate">{info.label}</span>
            </div>
          );
        })}
      </div>
      {/* Blackmagic's own one-line description of whatever the pointer is on,
          so the seven are learnable in place rather than by memorising them. */}
      {hover !== null && (
        <div className="absolute inset-x-0 bottom-16 flex justify-center">
          <div className="max-w-[70%] rounded-md border border-border-color bg-surface px-3 py-2 text-center text-xs text-text-secondary shadow-lg">
            {probeDisabled(DROP_EDIT_TYPES[hover].type) ?? DROP_EDIT_TYPES[hover].blurb}
          </div>
        </div>
      )}
    </div>
  );
}
