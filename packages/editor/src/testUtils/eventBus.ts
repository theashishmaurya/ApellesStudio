/**
 * testUtils/eventBus.ts — a stand-in for `@tauri-apps/api/event` that a test
 * can fire (D-454).
 *
 * The Edit preview's playback loop runs in Rust and reports each frame it
 * shows as `chroma://preview-playhead`; a jsdom suite plays that part by
 * firing the event itself. One module-level bus, so a `vi.mock` factory (which
 * `import`s this module) and the test body (which imports it too) share it:
 *
 *   vi.mock('@tauri-apps/api/event', async () => (await import('./testUtils/eventBus')).eventModule);
 *
 * Test-only.
 */

type Handler = (event: { payload: unknown }) => void;

const handlers = new Map<string, Set<Handler>>();

/** Fire `event` with `payload` at every listener registered for it. */
export function fireEvent(event: string, payload: unknown): void {
  for (const h of handlers.get(event) ?? []) h({ payload });
}

/** Forget every listener (between tests). */
export function resetEventBus(): void {
  handlers.clear();
}

/** The mocked `@tauri-apps/api/event` module. */
export const eventModule = {
  listen: (event: string, handler: Handler): Promise<() => void> => {
    const set = handlers.get(event) ?? new Set<Handler>();
    set.add(handler);
    handlers.set(event, set);
    return Promise.resolve(() => {
      set.delete(handler);
    });
  },
  emit: (): Promise<void> => Promise.resolve(),
};
