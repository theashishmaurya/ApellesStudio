/**
 * TimelineSwitchOverlay — the branded loader over the Edit tab while a timeline
 * switch loads (B-369).
 *
 * What it is: `@apelles/ui`'s `BrandedLoader` ("Opening Short 2…") over the
 * whole tab while `setActiveTimeline` runs (`switchingTimeline` in the store, set
 * by the switcher's click and `editor_set_active_timeline` alike). It appears
 * only once a switch has taken {@link SWITCH_LOADER_DELAY_MS}: a fast switch
 * swaps the timeline without a flash of loader.
 *
 * What it does NOT do: block input below a switch that is still under the
 * delay, or know why a switch is slow.
 */

import { useEffect, useState } from 'react';
import { BrandedLoader } from '@apelles/ui';

import { useEditorTimelineStore } from './timelineStore';

/** A switch faster than this shows no loader at all. */
export const SWITCH_LOADER_DELAY_MS = 150;

export function TimelineSwitchOverlay() {
  const switching = useEditorTimelineStore((s) => s.switchingTimeline);
  const [shown, setShown] = useState(false);
  useEffect(() => {
    if (switching === null) {
      setShown(false);
      return;
    }
    const timer = setTimeout(() => setShown(true), SWITCH_LOADER_DELAY_MS);
    return () => clearTimeout(timer);
  }, [switching]);
  if (switching === null || !shown) return null;
  return (
    <div className="absolute inset-0 z-50" data-testid="timeline-switch-overlay">
      <BrandedLoader variant="overlay" label={`Opening ${switching}…`} />
    </div>
  );
}
