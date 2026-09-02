/**
 * @chroma/shell — the 3-tab layout (D-039).
 *
 * A fixed-height tab bar (Edit / Motion / Colorist) over the active tab's
 * content. Tab content is injected by the caller through the `tabs` registry
 * prop, so this package depends only on react + zustand — never on the colorist
 * app or the editor/motion packages.
 *
 * Layout contract: the shell is a flex column filling its parent. The tab bar is
 * `shrink-0` (h-9); the content area is `flex-1 min-h-0 overflow-hidden`. Every
 * tab stays mounted (state is preserved across switches); inactive tabs are
 * `hidden`. A tab whose content assumes it owns the whole window (the Colorist
 * app) should size its root with `h-full`, not `h-screen`.
 *
 * Keyboard: Cmd/Ctrl+1 / +2 / +3 switch tabs.
 */

import { useEffect, type ReactNode } from 'react';
import { useShellStore, type ShellTabId } from './store';

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
    <div className="flex flex-col h-full w-full bg-bg-primary text-text-primary overflow-hidden">
      <div
        role="tablist"
        aria-label="Chroma tabs"
        className="shrink-0 h-9 flex items-stretch gap-1 px-2 bg-surface border-b border-border-color select-none"
      >
        <div className="flex items-center pr-3 mr-1 text-[11px] font-semibold tracking-wide text-text-secondary/70">
          CHROMA
        </div>
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
