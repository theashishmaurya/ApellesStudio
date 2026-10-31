/**
 * @apelles/editor — the two-up trim viewer (D-432 P3, `docs/notes/ui-redesign.md`
 * §5.1; B-348's `trim-two-up-viewer`), after Final Cut's "Show 2-Up When
 * Trimming".
 *
 * What it is: an overlay over the Edit viewer's picture, shown only while a
 * roll, slip or slide is dragged (`previewPeek.ts`'s `twoUp`, fed by
 * `useEditGesture` through `twoUp.ts`): the outgoing frame on the left and the
 * incoming one on the right, each with its label ("Out" / "In", "Start" /
 * "End") and its timecode, split by a 2 px divider.
 *
 * How it stays fast: each half is fetched with `chroma_trim_view_frame` (a
 * SOURCE frame, on its own decode-pipe lane and slot, so a drag reads each side
 * sequentially) latest-wins — at most one request in flight per half, and a
 * drag that outruns the decoder only ever asks for the newest frame. The
 * picture is written to its `<img>` imperatively, as `PreviewPane` writes its
 * own (D-290). When the gesture ends the pipes are released
 * (`chroma_trim_view_end`).
 *
 * What it does NOT do: show a timeline-composited frame (no grade, no
 * transform: the picture being cut, as Final Cut's two-up shows it), or
 * anything for trim / ripple (one-up in the spec; the viewer keeps the
 * playhead's frame).
 */

import { useEffect, useRef } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { fmtTimecode } from '@apelles/player';

import { usePreviewPeekStore, type TwoUpHalf } from './previewPeek';
import { useEditorTimelineStore } from './timelineStore';
import { timelineFps } from './timeline';
import { TIMELINE_TEST_IDS } from './timelineTestIds';

/** Each half's decode size: half the viewer, so a 1280 long edge is plenty. */
const TWO_UP_LONG_EDGE = 1280;
const PREVIEW_MIME = 'image/jpeg';

/** Latest-wins fetch of one half's frame into its `<img>`. */
function useHalfFrame(half: TwoUpHalf | null, index: 0 | 1) {
  const imgRef = useRef<HTMLImageElement | null>(null);
  const urlRef = useRef<string | null>(null);
  const inFlight = useRef(false);
  const pending = useRef<TwoUpHalf | null>(null);

  useEffect(() => {
    if (!half || !half.sourcePath) return;
    const run = async (first: TwoUpHalf) => {
      if (inFlight.current) {
        pending.current = first;
        return;
      }
      inFlight.current = true;
      let next: TwoUpHalf | null = first;
      while (next) {
        const want: TwoUpHalf = next;
        pending.current = null;
        try {
          const bytes = await invoke<ArrayBuffer>('chroma_trim_view_frame', {
            sourcePath: want.sourcePath,
            sourceFrame: Math.max(0, Math.round(want.sourceFrame)),
            half: index,
            maxLongEdge: TWO_UP_LONG_EDGE,
          });
          const url = URL.createObjectURL(new Blob([bytes], { type: PREVIEW_MIME }));
          const prev = urlRef.current;
          urlRef.current = url;
          if (imgRef.current) imgRef.current.src = url;
          if (prev) URL.revokeObjectURL(prev);
        } catch (e) {
          // A missing frame leaves the half dark rather than breaking the drag.
          console.warn('[TwoUpViewer] chroma_trim_view_frame failed', e);
        }
        next = pending.current;
      }
      inFlight.current = false;
    };
    void run(half);
  }, [half, index]);

  useEffect(
    () => () => {
      if (urlRef.current) URL.revokeObjectURL(urlRef.current);
      urlRef.current = null;
    },
    [],
  );
  return imgRef;
}

function Half({ half, index, fps }: { half: TwoUpHalf; index: 0 | 1; fps: number }) {
  const imgRef = useHalfFrame(half, index);
  return (
    <div className="relative flex min-w-0 flex-1 items-center justify-center bg-black" data-chroma-two-up-half={half.label}>
      {half.sourcePath ? (
        <img ref={imgRef} alt="" className="max-h-full max-w-full object-contain" />
      ) : (
        <span className="text-xs text-text-tertiary">No picture</span>
      )}
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
    invoke('chroma_trim_view_end').catch((e: unknown) => console.warn('[TwoUpViewer] chroma_trim_view_end failed', e));
  }, [twoUp]);

  if (!twoUp) return null;
  return (
    <div
      data-testid={TIMELINE_TEST_IDS.twoUpViewer}
      className="pointer-events-none absolute inset-0 z-10 flex gap-0.5 bg-divider"
    >
      <Half half={twoUp.left} index={0} fps={fps} />
      <Half half={twoUp.right} index={1} fps={fps} />
    </div>
  );
}
