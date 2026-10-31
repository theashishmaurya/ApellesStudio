/**
 * @apelles/editor — the timeline toolbar's playhead timecode (D-432 P5,
 * `docs/notes/ui-redesign.md` §4.9).
 *
 * **What it is.** The current time in `--color-playhead`, mono 13 / 600, then
 * `/` and the timeline's duration in `text-secondary`: the readout Final Cut
 * puts in the centre of its toolbar, beside the timeline name.
 *
 * **Why it renders nothing per frame.** The playhead changes on every played
 * frame. D-325 measured what a `playhead` selector costs a component that
 * re-renders on it, so this one does not select it: it subscribes to the store
 * and writes the new string straight into its own text node, the way
 * `PreviewPane` paints frames (D-290). React renders it only when the
 * timeline's rate or length changes.
 *
 * **What it does NOT do.** It is a readout, not a field: no click-to-type
 * timecode entry (FCP's own toolbar has one; not in this phase).
 */
import { useEffect, useRef } from 'react';
import { fmtTimecode } from '@apelles/player';

import { timelineDuration, timelineFps } from './timeline';
import { useEditorTimelineStore } from './timelineStore';

export interface PlayheadTimecodeProps {
  /** Also show `/ duration` after the current time. */
  withDuration?: boolean;
}

export function PlayheadTimecode({ withDuration }: PlayheadTimecodeProps) {
  const fps = useEditorTimelineStore((s) => timelineFps(s.timeline));
  const lastFrame = useEditorTimelineStore((s) => Math.max(0, timelineDuration(s.timeline) - 1));
  const currentRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    const write = (frame: number) => {
      if (currentRef.current) currentRef.current.textContent = fmtTimecode(frame, fps);
    };
    write(useEditorTimelineStore.getState().playhead);
    return useEditorTimelineStore.subscribe((s, prev) => {
      if (s.playhead !== prev.playhead) write(s.playhead);
    });
  }, [fps]);

  return (
    <span data-chroma-timecode="timeline" className="flex items-baseline gap-1 font-mono text-base tabular-nums">
      <span ref={currentRef} data-chroma-timecode-current className="font-semibold text-playhead" />
      {withDuration && (
        <>
          <span className="text-text-tertiary">/</span>
          <span className="text-text-secondary">{fmtTimecode(lastFrame, fps)}</span>
        </>
      )}
    </span>
  );
}
