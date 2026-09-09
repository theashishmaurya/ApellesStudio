/**
 * @apelles/keymap — dispatcher tests on real DOM (D-272).
 *
 * A real `keydown` on `window`, a real React component that claimed an action
 * with `useShortcut`, and the assertion that the handler ran. The whole point
 * of the registry is that this path works without the component comparing a
 * key to anything, and that a remap changes which key reaches it.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, cleanup, act } from '@testing-library/react';

import { useKeymapStore } from './store';
import { __resetKeymapDispatcherForTests, useShortcut } from './useShortcut';

function press(init: KeyboardEventInit & { code: string }) {
  act(() => {
    window.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init }));
  });
}

function Claimer({ id, on, enabled = true }: { id: string; on: () => void; enabled?: boolean }) {
  useShortcut(id, on, { enabled });
  return null;
}

beforeEach(() => {
  __resetKeymapDispatcherForTests();
  useKeymapStore.getState().setPersist(null);
  useKeymapStore.setState({ overrides: {}, activeScope: 'edit', osPlatform: 'macos' });
});

afterEach(() => {
  cleanup();
  __resetKeymapDispatcherForTests();
});

describe('the dispatcher', () => {
  it('runs the handler for the action the pressed combo maps to', () => {
    const play = vi.fn();
    render(<Claimer id="edit.play_pause" on={play} />);

    press({ code: 'Space', key: ' ' });

    expect(play).toHaveBeenCalledTimes(1);
  });

  it('routes a remapped combo, and stops routing the default one', () => {
    const play = vi.fn();
    render(<Claimer id="edit.play_pause" on={play} />);

    act(() => useKeymapStore.getState().setBinding('edit.play_pause', ['KeyP']));

    press({ code: 'Space', key: ' ' });
    expect(play).not.toHaveBeenCalled();

    press({ code: 'KeyP', key: 'p' });
    expect(play).toHaveBeenCalledTimes(1);
  });

  it('is silent for an action nobody has claimed, and leaves the event alone', () => {
    // Nothing rendered — `edit.split` is in the registry but unowned here.
    const event = new KeyboardEvent('keydown', {
      bubbles: true,
      cancelable: true,
      code: 'KeyK',
      key: 'k',
      metaKey: true,
    });
    act(() => {
      window.dispatchEvent(event);
    });
    expect(event.defaultPrevented).toBe(false);
  });

  it('preventDefaults once a handler takes the key', () => {
    render(<Claimer id="edit.play_pause" on={() => {}} />);
    const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, code: 'Space', key: ' ' });
    act(() => {
      window.dispatchEvent(event);
    });
    expect(event.defaultPrevented).toBe(true);
  });

  it('does not fire a tab-scoped action while another tab is frontmost (B-138)', () => {
    const marker = vi.fn();
    render(<Claimer id="edit.add_marker" on={marker} />);

    act(() => useKeymapStore.getState().setActiveScope('colorist'));
    press({ code: 'KeyM', key: 'm' });
    expect(marker).not.toHaveBeenCalled();

    act(() => useKeymapStore.getState().setActiveScope('edit'));
    press({ code: 'KeyM', key: 'm' });
    expect(marker).toHaveBeenCalledTimes(1);
  });

  it('fires a global action in every tab', () => {
    const undo = vi.fn();
    render(<Claimer id="app.undo" on={undo} />);

    for (const scope of ['edit', 'motion', 'colorist'] as const) {
      act(() => useKeymapStore.getState().setActiveScope(scope));
      press({ code: 'KeyZ', key: 'z', metaKey: true });
    }
    expect(undo).toHaveBeenCalledTimes(3);
  });

  it('honours `enabled: false` without removing the action from the registry', () => {
    const play = vi.fn();
    render(<Claimer id="edit.play_pause" on={play} enabled={false} />);
    press({ code: 'Space', key: ' ' });
    expect(play).not.toHaveBeenCalled();
  });

  it('does not fire while a text field has focus', () => {
    const marker = vi.fn();
    render(<Claimer id="edit.add_marker" on={marker} />);

    const input = document.createElement('input');
    document.body.appendChild(input);
    input.focus();

    press({ code: 'KeyM', key: 'm' });
    expect(marker).not.toHaveBeenCalled();

    input.remove();
  });

  it('DOES fire while a number input has focus — it holds no prose to protect', () => {
    const undo = vi.fn();
    render(<Claimer id="app.undo" on={undo} />);

    const input = document.createElement('input');
    input.type = 'number';
    document.body.appendChild(input);
    input.focus();

    press({ code: 'KeyZ', key: 'z', metaKey: true });
    expect(undo).toHaveBeenCalledTimes(1);

    input.remove();
  });

  it('stops listening once the last claimer unmounts', () => {
    const play = vi.fn();
    const { unmount } = render(<Claimer id="edit.play_pause" on={play} />);
    unmount();
    press({ code: 'Space', key: ' ' });
    expect(play).not.toHaveBeenCalled();
  });

  it('always calls the newest handler, without re-registering', () => {
    const first = vi.fn();
    const second = vi.fn();
    const { rerender } = render(<Claimer id="edit.play_pause" on={first} />);
    rerender(<Claimer id="edit.play_pause" on={second} />);

    press({ code: 'Space', key: ' ' });

    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });
});
