/**
 * useDebugScreenshot — the HUMAN half of the debug webview screenshot (D-210).
 *
 * What it is: one global keyboard shortcut (Cmd/Ctrl+Shift+D) that calls the
 *   `chroma_debug_screenshot` Tauri command and toasts back the absolute path
 *   of the PNG it wrote. Same command, same capture, same file the MCP
 *   `debug_screenshot` tool an agent calls produces — one capability, both
 *   interfaces (CLAUDE.md's "every feature is built for a human AND an AI").
 *   For a human the payoff is a bug report with a real picture attached, taken
 *   without leaving the app.
 *
 * What it does NOT do: pick a directory, preview the image, copy it to the
 *   clipboard, or capture anything outside the webview (see
 *   `app/src-tauri/src/chroma/debug_capture.rs` for why the last one is a hard
 *   limit, not an omission). Screenshots land in
 *   `$TMPDIR/chroma-debug-screenshots/`, or `$CHROMA_DEBUG_SHOTS_DIR` if set.
 *
 * Why its own hook rather than an entry in `KEYBIND_DEFINITIONS`: that table is
 * upstream RapidRAW's user-rebindable keybind system, and every entry needs an
 * i18n description string in each locale. This is a fixed developer/bug-report
 * affordance, not a user-facing editing action, so it stays a self-contained
 * Apelles file with a documented, non-rebindable combo — a smaller divergence
 * from upstream (D-003) than widening the shared table.
 *
 * Mounted once in App.tsx, next to `useChromaControl()`.
 */
import { useEffect } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { toast } from 'react-toastify';

/** Deliberately not one of `KEYBIND_DEFINITIONS`' combos: Ctrl/Cmd+Shift+D is
 *  unused there (Ctrl+Shift+C and Ctrl+Shift+B are the only two taken), and
 *  Cmd+Shift+3/4/5 are owned by macOS itself. */
const SCREENSHOT_KEY = 'd';

interface DebugScreenshotResult {
  path: string;
  label: string;
  width: number;
  height: number;
  scaleFactor: number;
  bytes: number;
}

export function useDebugScreenshot(): void {
  useEffect(() => {
    // B-100/D-219 — `chroma_debug_screenshot` is `#[cfg(debug_assertions)]`
    // now, so in a release build the command does not exist and this shortcut
    // would only ever toast "command not found". Gated with it, on the
    // frontend's equivalent compile-time constant: `vite build` folds
    // `import.meta.env.DEV` to `false` and drops everything below.
    if (!import.meta.env.DEV) return;

    const onKeyDown = async (event: KeyboardEvent) => {
      if (!event.shiftKey || !(event.metaKey || event.ctrlKey) || event.altKey) {
        return;
      }
      if (event.key.toLowerCase() !== SCREENSHOT_KEY) {
        return;
      }
      event.preventDefault();

      try {
        const shot = await invoke<DebugScreenshotResult>('chroma_debug_screenshot', {});
        toast.success(`Screenshot ${shot.width}×${shot.height} saved to ${shot.path}`, {
          autoClose: 8000,
        });
      } catch (err) {
        toast.error(`Screenshot failed: ${err}`);
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);
}
