// Regression test for B-194's frontend half — a corrupt or briefly-unreadable
// `settings.json` must never be treated as "settings loaded successfully."
//
// `useAppInitialization.ts`'s `LoadSettings` catch handler (the actual site of
// the bug — a React effect, not directly unit-testable here since `app/` has
// no jsdom/testing-library dependency; see `docs/BUGS.md` B-194 for what was
// verified by reading instead) is the only caller of `setSettingsLoadError`.
// This pins the store contract that fix relies on: a load failure is a real,
// inspectable state (`settingsLoadError`), and `appSettings` is left `null`
// rather than being fabricated into a synthetic default — which is exactly
// what every auto-persist effect in `useAppInitialization` gates on
// (`if (isInitialMount.current || !appSettings) return;`) to avoid writing a
// default over the user's real settings file.
import { beforeEach, describe, expect, it } from 'vitest';
import { useSettingsStore } from './useSettingsStore';

const INITIAL = useSettingsStore.getState();

beforeEach(() => {
  useSettingsStore.setState({ ...INITIAL, appSettings: null, settingsLoadError: null });
});

describe('settingsLoadError (B-194)', () => {
  it('starts clear, the way a freshly launched app boots', () => {
    expect(useSettingsStore.getState().settingsLoadError).toBeNull();
    expect(useSettingsStore.getState().appSettings).toBeNull();
  });

  it('records a load failure without inventing a loaded appSettings value', () => {
    useSettingsStore.getState().setSettingsLoadError('parse settings.json: EOF while parsing an object');

    const { settingsLoadError, appSettings } = useSettingsStore.getState();
    expect(settingsLoadError).toBe('parse settings.json: EOF while parsing an object');
    // The bug's exact mechanism: a failed load must not leave `appSettings`
    // looking like a real, saved value — every auto-persist effect in
    // `useAppInitialization` treats a non-null `appSettings` as "safe to
    // write back," which is precisely what turned a corrupt file into a
    // silently-overwritten one.
    expect(appSettings).toBeNull();
  });

  it('is cleared by a subsequent successful load', () => {
    useSettingsStore.getState().setSettingsLoadError('read settings.json: permission denied');
    useSettingsStore.getState().setSettingsLoadError(null);

    expect(useSettingsStore.getState().settingsLoadError).toBeNull();
  });
});
