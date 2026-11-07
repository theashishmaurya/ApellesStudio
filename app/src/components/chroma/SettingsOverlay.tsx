/**
 * B-396 — the Settings panel as a full-window overlay, above the tabs.
 *
 * What it is: the one place `SettingsPanel` is rendered, mounted from
 * `Root.tsx` beside the chrome bar rather than inside a tab.
 *
 * Why it moved: it used to live in `App.tsx`, which IS the Colorist tab, so it
 * could only ever appear while Colorist was frontmost — and the only way to
 * open it was `ctrl+,`, itself registered as a `colorist` action. From Edit or
 * Motion the app therefore had no settings at all, by button or by key, which
 * is exactly how it read to the owner (2026-11-05: "there is no setting in the
 * GUI").
 *
 * What it does NOT do: own the flag. `useUIStore.isSettingsOpen` is still the
 * single source of truth, so the gear, the shortcut and the native menu item
 * all drive this one surface.
 */
import SettingsPanel from '../panel/SettingsPanel';
import { useSettingsStore } from '../../store/useSettingsStore';
import { useUIStore } from '../../store/useUIStore';

export function SettingsOverlay() {
  const isSettingsOpen = useUIStore((s) => s.isSettingsOpen);
  const setUI = useUIStore((s) => s.setUI);
  const appSettings = useSettingsStore((s) => s.appSettings);
  const handleSettingsChange = useSettingsStore((s) => s.handleSettingsChange);

  if (!isSettingsOpen || !appSettings) return null;
  return (
    <div className="absolute inset-0 z-50 flex bg-bg-secondary">
      <div className="w-full h-full flex flex-col p-4 lg:p-8 overflow-y-auto custom-scrollbar">
        <SettingsPanel
          appSettings={appSettings}
          onBack={() => setUI({ isSettingsOpen: false })}
          onSettingsChange={handleSettingsChange}
        />
      </div>
    </div>
  );
}
