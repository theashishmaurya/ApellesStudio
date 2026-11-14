// @vitest-environment jsdom
/**
 * SettingsButton on real DOM — B-396's missing opener.
 *
 * Why it exists: before B-396 the app had no Settings button anywhere, on any
 * tab, and its one shortcut was `colorist`-scoped, so the owner's reading —
 * "there is no setting in the GUI" — was the only conclusion the interface
 * supported. The fix added this gear to the chrome bar. Nothing pinned it, and
 * a missing button is invisible to every other test in the suite.
 *
 * Pinned here: a real, labelled button renders, and pressing it opens the one
 * shared Settings flag (`useUIStore.isSettingsOpen`) that the shortcut and the
 * native menu item also set — so the three ways in cannot drift apart into
 * three surfaces.
 *
 * What it does NOT do: render the panel. `SettingsOverlay` owns that, above
 * the tabs, and the chrome-bar SLOT this fills is pinned in
 * `packages/shell/src/Shell.settingsAction.dom.test.tsx`.
 *
 * Same jsdom pragma + `@testing-library/react` pattern as
 * `AgentActivityDock.dom.test.tsx`; `app/`'s vitest workspace is `node` by
 * default.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

import { useUIStore } from '../../store/useUIStore';
import { SettingsButton } from './SettingsButton';

const UI_STORE_INITIAL = useUIStore.getState();

beforeEach(() => {
  useUIStore.setState({ ...UI_STORE_INITIAL, isSettingsOpen: false });
});

afterEach(cleanup);

describe('SettingsButton (B-396)', () => {
  it('renders a labelled button — the app had none at all', () => {
    render(<SettingsButton />);
    const button = screen.getByRole('button', { name: 'Settings' });
    expect(button).toBeTruthy();
    expect(button.getAttribute('title')).toBe('Settings');
  });

  it('opens the one shared Settings flag, the same one the shortcut and the menu set', () => {
    render(<SettingsButton />);
    expect(useUIStore.getState().isSettingsOpen).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Settings' }));
    expect(useUIStore.getState().isSettingsOpen).toBe(true);
  });
});
