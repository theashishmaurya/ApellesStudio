/**
 * B-396 — Settings' opener in the chrome bar.
 *
 * What it is: one gear button that opens the Settings panel, beside Keyboard
 * shortcuts and Connect to MCP, from any tab.
 *
 * Why it exists: Settings had no button anywhere in the app. The only way in
 * was `ctrl+,` — unlabelled, undiscoverable, and registered as a `colorist`
 * action, so it did nothing at all while the Edit or Motion tab was frontmost.
 * The owner's conclusion, reasonably, was "there is no setting in the GUI"
 * (2026-11-05), which also made the one real feature flag (D-433's AI video
 * understanding, Settings → Processing) unreachable in practice.
 *
 * What it does NOT do: own the panel or its state. The flag lives in
 * `useUIStore` and the panel is rendered by `SettingsOverlay`, from `Root.tsx`
 * above the tabs (it used to render inside the Colorist tab's container in
 * `App.tsx`, which is half of why it was unreachable); this only sets the flag,
 * so the button, the keyboard shortcut and the native menu all open the same
 * one thing.
 */
import { GearSixIcon } from '@phosphor-icons/react';
import { Button } from '@apelles/ui';

import { useUIStore } from '../../store/useUIStore';

export function SettingsButton() {
  const setUI = useUIStore((s) => s.setUI);
  return (
    <Button
      variant="ghost"
      size="xs"
      onClick={() => setUI({ isSettingsOpen: true })}
      title="Settings"
      aria-label="Settings"
      className="h-6 w-6 p-0 text-text-secondary hover:text-text-primary"
    >
      <GearSixIcon className="size-3.5" />
    </Button>
  );
}
