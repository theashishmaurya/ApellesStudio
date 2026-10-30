/**
 * @apelles/editor — the Edit preview toolbar's Safe Area menu (D-431).
 *
 * What it is: one icon button (Phosphor `FrameCornersIcon`) that opens a radio
 * menu — Off / Title + Action safe / YouTube Shorts / Instagram Reels / TikTok /
 * All vertical platforms — writing `safeAreaView` in the Edit store, the very
 * value `editor_set_safe_area_view` writes. The presets that fit the active
 * timeline's shape (vertical presets for a 9:16 timeline) are listed first and
 * marked "suggested", and the button carries a dot while a guide is off on a
 * vertical timeline, so a short is never exported without having been offered
 * the check. It never switches the guide on by itself.
 *
 * What it does NOT do: draw anything (`SafeAreaOverlay`) or own any numbers
 * (`safeAreas.ts`).
 */
import { Fragment } from 'react';
import { FrameCornersIcon } from '@phosphor-icons/react';
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@apelles/ui';

import type { CompositionSize } from './useCompositionSize';
import { SAFE_AREA_PRESETS, isSafeAreaViewId, suggestedPresets, type SafeAreaViewId } from './safeAreas';
import { useEditorTimelineStore } from './timelineStore';

export function SafeAreaMenu({ size }: { size: CompositionSize | null }) {
  const view = useEditorTimelineStore((s) => s.safeAreaView);
  const setView = useEditorTimelineStore((s) => s.setSafeAreaView);
  const suggested = size ? suggestedPresets(size.width, size.height) : [];
  const ordered: SafeAreaViewId[] = [
    ...suggested,
    ...SAFE_AREA_PRESETS.map((p) => p.id).filter((id) => !suggested.includes(id)),
  ];
  const vertical = !!size && size.height > size.width;
  const on = view !== 'off';

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            variant="ghost"
            size="icon-sm"
            title="Safe area guides"
            aria-label="Safe area guides"
            aria-pressed={on}
            data-safe-area-trigger=""
            className={on ? 'relative text-accent' : 'relative'}
          >
            <FrameCornersIcon />
            {!on && vertical && (
              <span
                className="absolute right-0.5 top-0.5 size-1.5 rounded-full bg-accent"
                data-safe-area-hint=""
                title="Vertical timeline: check the platform safe areas"
              />
            )}
          </Button>
        }
      />
      <DropdownMenuContent align="end" data-safe-area-menu="">
        <DropdownMenuRadioGroup
          value={view}
          onValueChange={(v) => {
            if (isSafeAreaViewId(v)) setView(v);
          }}
        >
          <DropdownMenuRadioItem value="off">Off</DropdownMenuRadioItem>
          <DropdownMenuSeparator />
          <DropdownMenuLabel>{vertical ? 'Suggested for this timeline' : 'Guides'}</DropdownMenuLabel>
          {ordered.map((id, i) => (
            <Fragment key={id}>
              {i === suggested.length && suggested.length > 0 && <DropdownMenuSeparator />}
              <DropdownMenuRadioItem value={id}>
                {SAFE_AREA_PRESETS.find((p) => p.id === id)?.label}
              </DropdownMenuRadioItem>
            </Fragment>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
