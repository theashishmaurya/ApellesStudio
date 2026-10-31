/**
 * @apelles/editor — the Inspector's number field: `@apelles/ui`'s
 * `NumberScrubber` wired to this tab's undo (D-432, P4).
 *
 * **What it is.** A `NumberScrubber` whose scrub gesture is bracketed by the
 * timeline store's history group (`beginHistoryGroup` / `endHistoryGroup`), so
 * the per-frame ops a scrub applies fold into **one undo step** — the P4
 * harness requirement. Typed commits and arrow steps are single ops and are
 * not grouped.
 *
 * **What it does NOT do.** It adds no behaviour of its own and holds no value.
 * Every Inspector number (`PropertyRow`, Width / Height, Fade, the project
 * settings form) uses this rather than the bare scrubber, so a field cannot
 * forget the bracket.
 */
import { NumberScrubber, type NumberScrubberProps } from '@apelles/ui';

import { beginHistoryGroup, endHistoryGroup } from './timelineStore';

export function InspectorNumber(props: Omit<NumberScrubberProps, 'onScrubStart' | 'onScrubEnd'>) {
  return <NumberScrubber {...props} onScrubStart={beginHistoryGroup} onScrubEnd={endHistoryGroup} />;
}
