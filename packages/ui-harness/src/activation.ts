/**
 * activation.ts - make Apelles the front app for a run, and hand the front back (H15).
 *
 * What it is: WebKit delivers a buttonless pointer move only to a KEY window, and
 * a window is only key while its app is the active one, so the hover scenarios
 * (`clip-body-hover-cursor`, `track-header-present`) were SKIPped whenever the
 * harness ran from a terminal. `debug_activate_app` (a debug-only native op: app
 * activate plus `makeKeyAndOrderFront`) brings Apelles forward; this module calls
 * it at the start of a run and, at the end, calls it again with `restorePid` so
 * the app that had the front gets it back and the owner's desktop is as they left it.
 *
 * What it does NOT do: fail a run itself (it reports `locked`; the CLI stops, B-352). An app that cannot be activated leaves hover
 * scenarios to skip themselves (H5's key-window check), and says so in the report.
 */

import type { OpClient } from './client.ts';

interface AppRef {
  pid: number;
  name?: string | null;
}

interface Activation {
  previous: AppRef | null;
  now: AppRef | null;
  active: boolean;
  windowKey: boolean;
}

export interface FrontState {
  /** The app to give the front back to; `null` when Apelles was already in front or activation failed. */
  restorePid: number | null;
  notes: string[];
  /** The Mac's screen is locked or asleep (the frontmost app is `loginwindow`):
   *  no window can become key and rAF never fires, so a run cannot measure (B-352). */
  locked: boolean;
}

/** The message `debug_activate_app` fails with when the front is the login window. */
export function isScreenLockedError(message: string): boolean {
  return /frontmost app is loginwindow/.test(message);
}

/** Bring Apelles to the front; report who had it. */
export async function activateApp(client: OpClient): Promise<FrontState> {
  const notes: string[] = [];
  try {
    const r = await client.op<Activation>('debug_activate_app', {});
    if (!r.active || !r.windowKey) {
      notes.push(`Apelles was asked to come to the front but is ${r.active ? 'not key' : 'not active'} (front: ${r.now?.name ?? r.now?.pid ?? 'unknown'}); hover scenarios may skip`);
    }
    const handBack = r.previous && r.now && r.previous.pid !== r.now.pid ? r.previous : null;
    if (handBack) notes.push(`Apelles was brought to the front (it was behind ${handBack.name ?? `pid ${handBack.pid}`}); the front is handed back at the end`);
    return { restorePid: handBack?.pid ?? null, notes, locked: false };
  } catch (e) {
    const message = String((e as Error).message);
    notes.push(`could not bring Apelles to the front (${message}); hover scenarios may skip`);
    return { restorePid: null, notes, locked: isScreenLockedError(message) };
  }
}

/** Give the front back to the app that had it. Never throws. */
export async function restoreFront(client: OpClient, state: FrontState): Promise<string[]> {
  if (state.restorePid === null) return [];
  try {
    await client.op('debug_activate_app', { restorePid: state.restorePid });
    return [];
  } catch (e) {
    return [`could not hand the front back to pid ${state.restorePid} (${String((e as Error).message)})`];
  }
}
