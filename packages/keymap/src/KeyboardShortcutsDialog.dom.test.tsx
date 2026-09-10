/**
 * @apelles/keymap — KeyboardShortcutsDialog behaviour tests (D-278).
 *
 * D-278 only changed the LAYOUT (single stacked column → a CSS multi-column
 * grid, per-row borders and the sticky header dropped). Every interaction
 * D-273 built — click-to-record, Escape-to-unassign, per-row reset, "Restore
 * Defaults", the scope tag, the ⚠ shadowed-action flag — is asserted here on
 * the real DOM the new layout renders, so a layout change that silently moved
 * a hit target or hid a tag would fail loudly rather than just "looking off".
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { render, cleanup, act, screen, within } from '@testing-library/react';

import { KeyboardShortcutsDialog } from './KeyboardShortcutsDialog';
import { useKeymapStore } from './store';

function press(init: KeyboardEventInit & { code: string }) {
  act(() => {
    window.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init }));
  });
}

function clickChip(id: string) {
  const chip = document.querySelector(`[data-chroma-shortcut="${id}"]`);
  if (!chip) throw new Error(`no chip for ${id}`);
  act(() => {
    (chip as HTMLElement).click();
  });
  return chip as HTMLElement;
}

beforeEach(() => {
  useKeymapStore.getState().setPersist(null);
  useKeymapStore.setState({ overrides: {}, activeScope: 'edit', osPlatform: 'macos' });
});

afterEach(() => {
  cleanup();
});

describe('KeyboardShortcutsDialog', () => {
  it('renders every category with its scope tag, and rows carry their chip', () => {
    render(<KeyboardShortcutsDialog open onOpenChange={() => {}} />);

    expect(screen.getByText('Application')).toBeTruthy();
    expect(screen.getByText('Playback')).toBeTruthy();
    expect(screen.getByText('Trim tools')).toBeTruthy();

    // The scope tag sits next to its category header (D-273's own divergence
    // from the macOS reference, kept unchanged by the D-278 layout pass).
    const playbackHeader = screen.getByText('Playback').closest('header');
    expect(playbackHeader).not.toBeNull();
    expect(within(playbackHeader as HTMLElement).getByText('Edit')).toBeTruthy();

    const appHeader = screen.getByText('Application').closest('header');
    expect(within(appHeader as HTMLElement).getByText('All tabs')).toBeTruthy();

    // A real row, with its combo chip, exists for a known action.
    expect(document.querySelector('[data-chroma-shortcut="edit.play_pause"]')).toBeTruthy();
  });

  it('click-to-record: clicking a chip enters recording, and the next chord rebinds it', () => {
    render(<KeyboardShortcutsDialog open onOpenChange={() => {}} />);

    const chip = clickChip('edit.play_pause');
    expect(chip.textContent).toBe('Press keys…');

    press({ code: 'KeyP', key: 'p' });

    expect(useKeymapStore.getState().overrides['edit.play_pause']).toEqual(['KeyP']);
    expect(chip.textContent).toBe('P');
  });

  it('Escape while recording leaves the action unassigned, not reverted', () => {
    render(<KeyboardShortcutsDialog open onOpenChange={() => {}} />);

    const chip = clickChip('edit.add_marker');
    expect(chip.textContent).toBe('Press keys…');

    press({ code: 'Escape', key: 'Escape' });

    // `[]` is a real stored override meaning "unassigned" (store.ts), not the
    // same as never having been touched.
    expect(useKeymapStore.getState().overrides['edit.add_marker']).toEqual([]);
    expect(chip.textContent).toBe('Not assigned');
  });

  it('a modified row gets a per-row reset button that restores the default', () => {
    render(<KeyboardShortcutsDialog open onOpenChange={() => {}} />);

    // No reset affordance before anything is changed.
    expect(screen.queryByLabelText('Reset Play / Pause to default')).toBeNull();

    clickChip('edit.play_pause');
    press({ code: 'KeyP', key: 'p' });

    const resetButton = screen.getByLabelText('Reset Play / Pause to default');
    act(() => resetButton.click());

    expect(useKeymapStore.getState().overrides['edit.play_pause']).toBeUndefined();
    expect(document.querySelector('[data-chroma-shortcut="edit.play_pause"]')!.textContent).toBe('Space');
    expect(screen.queryByLabelText('Reset Play / Pause to default')).toBeNull();
  });

  it('"Restore Defaults" clears every override at once', () => {
    render(<KeyboardShortcutsDialog open onOpenChange={() => {}} />);

    clickChip('edit.play_pause');
    press({ code: 'KeyP', key: 'p' });
    clickChip('edit.add_marker');
    press({ code: 'Escape', key: 'Escape' });

    expect(Object.keys(useKeymapStore.getState().overrides)).toHaveLength(2);

    act(() => screen.getByText('Restore Defaults').click());

    expect(useKeymapStore.getState().overrides).toEqual({});
    expect(document.querySelector('[data-chroma-shortcut="edit.play_pause"]')!.textContent).toBe('Space');
    expect(document.querySelector('[data-chroma-shortcut="edit.add_marker"]')!.textContent).toBe('M');
  });

  it('flags a shadowed action with ⚠ when two actions share a combo in the same tab', () => {
    // edit.tool_select defaults to `V`; bind edit.add_marker onto the same
    // key so the two collide in the Edit tab.
    act(() => useKeymapStore.getState().setBinding('edit.add_marker', ['KeyV']));

    render(<KeyboardShortcutsDialog open onOpenChange={() => {}} />);

    const markerRow = document.querySelector('[data-chroma-shortcut="edit.add_marker"]')!.closest('li')!;
    const selectRow = document.querySelector('[data-chroma-shortcut="edit.tool_select"]')!.closest('li')!;
    expect(within(markerRow as HTMLElement).getByText('⚠')).toBeTruthy();
    expect(within(selectRow as HTMLElement).getByText('⚠')).toBeTruthy();

    // An unrelated, unconflicted row stays clean.
    const playRow = document.querySelector('[data-chroma-shortcut="edit.play_pause"]')!.closest('li')!;
    expect(within(playRow as HTMLElement).queryByText('⚠')).toBeNull();
  });

  it('closes the recording state when the dialog closes', () => {
    const { rerender } = render(<KeyboardShortcutsDialog open onOpenChange={() => {}} />);
    const chip = clickChip('edit.play_pause');
    expect(chip.textContent).toBe('Press keys…');

    rerender(<KeyboardShortcutsDialog open={false} onOpenChange={() => {}} />);
    rerender(<KeyboardShortcutsDialog open onOpenChange={() => {}} />);

    expect(document.querySelector('[data-chroma-shortcut="edit.play_pause"]')!.textContent).toBe('Space');
  });
});
