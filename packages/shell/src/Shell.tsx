/**
 * @chroma/shell — the 3-tab layout + window chrome (D-039).
 *
 * The top bar is the window title bar (the app runs `decorations: false`):
 * left = macOS traffic lights + the CHROMA wordmark; centre = the tabs
 * (Edit / Motion / Colorist), absolutely centred; right = Windows/Linux window
 * controls (a matching spacer on macOS so the centre stays true). The bar is a
 * `data-tauri-drag-region` except the buttons and tabs. See `WindowChrome.tsx`
 * for the ported platform logic.
 *
 * Tab content is injected by the caller through the `tabs` registry prop, so
 * this package depends only on react + zustand + Tauri (the shell owns the
 * chrome now) — never on the colorist app or the editor/motion packages.
 *
 * Layout contract: the shell is a flex column filling its parent. The tab bar
 * is `shrink-0` (h-10); the content area is `flex-1 min-h-0 overflow-hidden`.
 * Every tab stays mounted (state is preserved across switches); inactive tabs
 * are `hidden`. A tab whose content assumes it owns the whole window (the
 * Colorist app) should size its root with `h-full`, not `h-screen`.
 *
 * On macOS, windowed, the shell root carries `.macos-window-shell` (14px
 * rounded corners + clip) — before D-039 that class was on the Colorist app
 * root; the whole window is the shell's now.
 *
 * Keyboard: Cmd/Ctrl+1 / +2 / +3 switch tabs.
 */

import { useEffect, type ReactNode } from 'react';
import { useShellStore, type ShellTabId } from './store';
import { useWindowChrome, MacTrafficLights, WindowControls } from './WindowChrome';

export interface ShellTab {
  id: ShellTabId;
  label: string;
  icon?: ReactNode;
  element: ReactNode;
}

export interface ShellProps {
  tabs: ShellTab[];
}

export function Shell({ tabs }: ShellProps) {
  const activeTab = useShellStore((s) => s.activeTab);
  const setActiveTab = useShellStore((s) => s.setActiveTab);
  const chrome = useWindowChrome();

  // If persisted/default tab isn't in the registry, fall back to the first tab.
  const active = tabs.some((t) => t.id === activeTab) ? activeTab : tabs[0]?.id;

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.altKey || e.shiftKey) return;
      const idx = { '1': 0, '2': 1, '3': 2 }[e.key];
      if (idx === undefined) return;
      const tab = tabs[idx];
      if (!tab) return;
      e.preventDefault();
      setActiveTab(tab.id);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [tabs, setActiveTab]);

  return (
    <div
      className={
        'flex flex-col h-full w-full bg-bg-primary text-text-primary overflow-hidden ' +
        (chrome.useMacWindowShell ? 'macos-window-shell' : '')
      }
    >
      <div
        data-tauri-drag-region
        className="shrink-0 h-10 flex items-center gap-1 px-2 bg-surface border-b border-border-color select-none relative"
      >
        {/* left: traffic lights (mac) + wordmark */}
        <MacTrafficLights show={chrome.isMac && !chrome.isMobile} />
        <div className="flex items-center pr-2 text-[11px] font-semibold tracking-wide text-text-secondary/70 pointer-events-none">
          CHROMA
        </div>

        {/* centre: the tabs, absolutely centred */}
        <div
          role="tablist"
          aria-label="Chroma tabs"
          className="absolute left-1/2 -translate-x-1/2 flex items-stretch h-full gap-1"
        >
          {tabs.map((tab) => {
            const isActive = tab.id === active;
            return (
              <button
                key={tab.id}
                role="tab"
                type="button"
                aria-selected={isActive}
                onClick={() => setActiveTab(tab.id)}
                className={
                  'relative flex items-center gap-1.5 px-3 text-xs font-medium transition-colors ' +
                  (isActive
                    ? 'text-text-primary'
                    : 'text-text-secondary hover:text-text-primary')
                }
              >
                {tab.icon}
                {tab.label}
                <span
                  className={
                    'absolute left-2 right-2 bottom-0 h-0.5 rounded-full transition-colors ' +
                    (isActive ? 'bg-accent' : 'bg-transparent')
                  }
                />
              </button>
            );
          })}
        </div>

        {/* right: win/linux controls, or a spacer on mac */}
        <div className="ml-auto flex items-center h-full">
          <WindowControls chrome={chrome} />
        </div>
      </div>

      <div className="flex-1 min-h-0 flex flex-col overflow-hidden">
        {tabs.map((tab) => {
          const isActive = tab.id === active;
          return (
            <div
              key={tab.id}
              role="tabpanel"
              className={isActive ? 'flex-1 min-h-0 flex flex-col' : 'hidden'}
            >
              {tab.element}
            </div>
          );
        })}
      </div>
    </div>
  );
}
