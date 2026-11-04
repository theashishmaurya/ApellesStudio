/**
 * @apelles/editor — the two-up trim viewer (D-432 P3, `docs/notes/ui-redesign.md`
 * §5.1; B-348's `trim-two-up-viewer`), after Final Cut's "Show 2-Up When
 * Trimming".
 *
 * What it is: the labels over the Edit viewer's picture while a roll, slip or
 * slide is dragged (`previewPeek.ts`'s `twoUp`, fed by `useEditGesture`
 * through `twoUp.ts`): "Out" / "In" (or "Start" / "End") and each side's
 * timecode, split by a 2 px divider.
 *
 * **The two pictures are the preview surface's** (roadmap 00r 5d (c)): while a
 * two-up is in the peek store, `nativePreview.ts` draws the two source frames
 * into the native surface in place of the timeline's frame
 * (`chroma::edit::draw_two_up_frame`), letterboxed into the same two halves
 * this overlay labels. Until then each half fetched its own JPEG through
 * `chroma_trim_view_frame` and wrote it to an `<img>` — the last preview
 * picture that was read back, encoded and sent over IPC; that command and its
 * encode are deleted. This component therefore paints no background of its
 * own: the halves are transparent so the surface shows through, and only the
 * divider and the label strips are drawn.
 *
 * When the gesture ends the trim lane's decode pipes are released
 * (`endTrimView`).
 *
 * What it does NOT do: show a timeline-composited frame (no grade, no
 * transform: the picture being cut, as Final Cut's two-up shows it), or
 * anything for trim / ripple (one-up in the spec; the viewer keeps the
 * playhead's frame).
 */

import { useEffect, useRef } from 'react';
import { endTrimView } from '@apelles/bridge';
import { fmtTimecode } from '@apelles/player';

import { usePreviewPeekStore, type TwoUpHalf } from './previewPeek';
import { useEditorTimelineStore } from './timelineStore';
import { timelineFps } from './timeline';
import { TIMELINE_TEST_IDS } from './timelineTestIds';

function Half({ half, fps }: { half: TwoUpHalf; fps: number }) {
  return (
    <div className="relative flex min-w-0 flex-1 items-center justify-center" data-chroma-two-up-half={half.label}>
      {!half.sourcePath && <span className="text-xs text-text-tertiary">No picture</span>}
      <div className="pointer-events-none absolute inset-x-0 bottom-0 flex items-center justify-between bg-black/55 px-2 py-1 text-2xs text-text-primary">
        <span className="font-medium">{half.label}</span>
        <span className="font-mono tabular-nums">{fmtTimecode(half.timelineFrame, fps)}</span>
      </div>
    </div>
  );
}

/** The overlay itself; renders nothing outside a roll / slip / slide drag. */
export function TwoUpViewer() {
  const twoUp = usePreviewPeekStore((s) => s.twoUp);
  const fps = useEditorTimelineStore((s) => timelineFps(s.timeline));
  const wasOpen = useRef(false);

  useEffect(() => {
    if (twoUp) {
      wasOpen.current = true;
      return;
    }
    if (!wasOpen.current) return;
    wasOpen.current = false;
    // The gesture ended: give the trim lane's decoders back.
    endTrimView().catch((e: unknown) => console.warn('[TwoUpViewer] endTrimView failed', e));
  }, [twoUp]);

  if (!twoUp) return null;
  return (
    <div data-testid={TIMELINE_TEST_IDS.twoUpViewer} className="pointer-events-none absolute inset-0 z-10 flex">
      <Half half={twoUp.left} fps={fps} />
      {/* The gap `draw_two_up_frame` leaves between the two pictures. */}
      <div className="w-0.5 shrink-0 bg-divider" />
      <Half half={twoUp.right} fps={fps} />
    </div>
  );
}
