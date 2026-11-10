/**
 * `@apelles/bridge` — the in-app updater (D-458).
 *
 * **What it is:** the one place the frontend speaks to `@tauri-apps/plugin-updater`,
 * per D-447 — nothing above this file imports a `@tauri-apps/*` package, so the
 * transport can become HTTP/WebSocket later (roadmap 00i) without touching the UI.
 *
 * **What it does:** asks whether a newer signed release exists, and installs one
 * on request, reporting download progress. The check is deliberately explicit —
 * nothing here runs on a timer, because an editor that reaches out on its own
 * would break this repo's local-first rule (`docs/00-vision.md`); the caller
 * decides when, and the result says plainly when it has not been configured.
 *
 * **What it does NOT do:** decide policy (when to check, whether to nag), restart
 * the app (that is `relaunch` from the process plugin, called by the UI once the
 * user agrees), or verify anything itself. Verification is the plugin's: the
 * update manifest is signed with a key whose PUBLIC half is compiled into the
 * app from `tauri.conf.json`, and whose private half exists only as a release
 * secret. An unsigned or wrongly-signed update is refused before a byte of it is
 * installed, which is the entire reason an updater is safe to ship at all.
 */
import { check, type Update } from '@tauri-apps/plugin-updater';

/** What a check found. `configured: false` is a real answer, not a failure: a
 *  build made without a public key cannot check, and must say so rather than
 *  report "you are up to date" — which would be a lie that keeps someone on an
 *  old build forever. */
export type UpdateCheck =
  | { status: 'available'; version: string; notes: string | null; date: string | null }
  | { status: 'up-to-date' }
  | { status: 'not-configured' }
  | { status: 'failed'; error: string };

/** Progress while an update downloads, for a determinate bar. `total` is null
 *  until the server reports a content length; the UI shows an indeterminate bar
 *  until then rather than inventing a denominator. */
export type UpdateProgress = { downloaded: number; total: number | null };

/** The pending update between [`checkForUpdate`] and [`installUpdate`]. Held
 *  here rather than handed to the UI so no caller can install something it did
 *  not just check for. */
let pending: Update | null = null;

/** Is a newer signed release available? Never throws: a network failure is an
 *  answer (`failed`), not an exception to handle at every call site. */
export async function checkForUpdate(): Promise<UpdateCheck> {
  try {
    const update = await check();
    pending = update ?? null;
    if (!update) return { status: 'up-to-date' };
    return {
      status: 'available',
      version: update.version,
      notes: update.body ?? null,
      date: update.date ?? null,
    };
  } catch (e) {
    const message = String((e as Error)?.message ?? e);
    // A build with no `plugins.updater` key cannot check at all. Saying so is
    // the difference between "we looked and you are current" and "we never
    // looked" — the second must not masquerade as the first.
    if (/updater|endpoint|public key|pubkey|not configured/i.test(message)) {
      return { status: 'not-configured' };
    }
    return { status: 'failed', error: message };
  }
}

/**
 * Download and install the update [`checkForUpdate`] just found.
 *
 * Resolves once the new version is installed on disk; the app must be
 * relaunched to be running it, which is the caller's call to make with the
 * user, not this function's.
 */
export async function installUpdate(onProgress?: (p: UpdateProgress) => void): Promise<void> {
  if (!pending) {
    throw new Error('no update to install — call checkForUpdate() first');
  }
  let downloaded = 0;
  let total: number | null = null;
  await pending.downloadAndInstall((event) => {
    if (event.event === 'Started') {
      total = event.data.contentLength ?? null;
      onProgress?.({ downloaded: 0, total });
    } else if (event.event === 'Progress') {
      downloaded += event.data.chunkLength;
      onProgress?.({ downloaded, total });
    } else if (event.event === 'Finished') {
      onProgress?.({ downloaded: total ?? downloaded, total });
    }
  });
}

/** Forget a checked-but-not-installed update (the user dismissed it). */
export function clearPendingUpdate(): void {
  pending = null;
}
