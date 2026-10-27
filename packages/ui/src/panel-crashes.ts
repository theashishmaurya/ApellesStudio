/**
 * @apelles/ui — the registry of panels that are currently showing their crash
 * fallback (B-292).
 *
 * **What it is:** a tiny external store `PanelErrorBoundary` writes to when it
 * catches a render error and clears when the panel is reloaded. It exists so
 * something OUTSIDE the crashed subtree can know a panel is down: the
 * debug-only `debug_get_ui_state` reports it (`crashedPanels`), so an agent
 * driving the app sees "the Timeline panel crashed: …" instead of a screenshot
 * of a fallback it has to read.
 *
 * **What it does NOT do:** log (the boundary does that), recover anything, or
 * hold history — a panel that is reloaded drops out, and one that crashes
 * again is reported again with its count bumped.
 *
 * Subscribe/snapshot shape on purpose, the `useSyncExternalStore` contract, so
 * a component can render from it without the React Compiler caching a stale
 * read (the B-282 lesson).
 */

export interface PanelCrash {
  /** The boundary's `panel` name, e.g. `"Timeline"` or `"tab:edit"`. */
  panel: string;
  /** `error.message`, or the thrown value as text when it is not an `Error`. */
  message: string;
  /** The error's own stack, when it has one. */
  stack: string | null;
  /** React's component stack at the throw. */
  componentStack: string | null;
  /** When it was caught (ISO 8601). */
  at: string;
  /** How many times this panel has crashed since it last rendered cleanly. */
  count: number;
}

const crashes = new Map<string, PanelCrash>();
const listeners = new Set<() => void>();
let snapshot: readonly PanelCrash[] = [];

function publish(): void {
  snapshot = [...crashes.values()];
  for (const listener of listeners) listener();
}

/** Record that `panel` is showing its crash fallback. */
export function reportPanelCrash(crash: Omit<PanelCrash, 'count'>): void {
  const previous = crashes.get(crash.panel);
  crashes.set(crash.panel, { ...crash, count: (previous?.count ?? 0) + 1 });
  publish();
}

/** Record that `panel` is rendering its content again. A no-op for a panel
 *  that is not in the registry. */
export function clearPanelCrash(panel: string): void {
  if (!crashes.has(panel)) return;
  crashes.delete(panel);
  publish();
}

/** Every panel currently showing its crash fallback. A stable array between
 *  changes, as `useSyncExternalStore` requires. */
export function getPanelCrashes(): readonly PanelCrash[] {
  return snapshot;
}

export function subscribePanelCrashes(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
