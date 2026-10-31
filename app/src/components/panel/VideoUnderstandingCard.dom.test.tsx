// @vitest-environment jsdom
/**
 * The "AI video understanding" Settings card on real DOM (D-432).
 *
 * What it pins: the opt-in is OFF until the user flips it; flipping goes through
 * the backend command and survives a remount (the backend, not the component, is
 * the source of truth); the Mac's RAM is shown; and under 16 GB a clear warning
 * appears while the toggle stays usable. Tauri is faked with a tiny in-memory
 * backend that implements the two commands the way `chroma/video_understanding.rs`
 * does (including its `lowMemory` rule), so the test exercises the real bridge
 * store and the real component, not a mocked-out store.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

const GIB = 1024 ** 3;

const backend = { enabled: false, totalMemoryBytes: 24 * GIB as number | null };
const invokeLog: Array<[string, unknown]> = [];

function status() {
  return {
    enabled: backend.enabled,
    totalMemoryBytes: backend.totalMemoryBytes,
    lowMemory: backend.totalMemoryBytes !== null && backend.totalMemoryBytes < 16 * GIB,
    refusal: backend.enabled ? null : 'AI video understanding is turned off.',
    howToEnable: 'Settings → Processing → AI video understanding',
  };
}

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(async (command: string, args?: { enabled?: boolean }) => {
    invokeLog.push([command, args]);
    if (command === 'chroma_set_video_understanding') backend.enabled = !!args?.enabled;
    return status();
  }),
}));
vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(async () => () => {}),
}));

const { useVideoUnderstandingStore } = await import('@apelles/bridge');
const { default: VideoUnderstandingCard } = await import('./VideoUnderstandingCard');

beforeEach(() => {
  backend.enabled = false;
  backend.totalMemoryBytes = 24 * GIB;
  invokeLog.length = 0;
  useVideoUnderstandingStore.setState({ status: null });
});
afterEach(cleanup);

async function toggle(): Promise<HTMLElement> {
  const control = await screen.findByRole('switch');
  await waitFor(() => expect(control.hasAttribute('disabled')).toBe(false));
  return control;
}

describe('VideoUnderstandingCard (D-432)', () => {
  it('is off by default and says what it costs', async () => {
    render(<VideoUnderstandingCard />);
    const control = await toggle();
    expect(control.getAttribute('aria-checked')).toBe('false');
    expect(screen.getByText(/Downloads a ~3 GB model; uses up to ~9 GB of memory/)).toBeTruthy();
    expect(screen.getByText(/24 GB of memory/)).toBeTruthy();
  });

  it('persists through the backend: turning it on survives a remount', async () => {
    const first = render(<VideoUnderstandingCard />);
    fireEvent.click(await toggle());
    await waitFor(() => expect(backend.enabled).toBe(true));
    expect(invokeLog).toContainEqual(['chroma_set_video_understanding', { enabled: true }]);
    first.unmount();

    useVideoUnderstandingStore.setState({ status: null });
    render(<VideoUnderstandingCard />);
    const control = await toggle();
    await waitFor(() => expect(control.getAttribute('aria-checked')).toBe('true'));
  });

  it('warns under 16 GB but keeps the toggle usable', async () => {
    backend.totalMemoryBytes = 8 * GIB;
    render(<VideoUnderstandingCard />);
    const control = await toggle();
    expect((await screen.findByRole('alert')).textContent).toMatch(/8 GB/);
    fireEvent.click(control);
    await waitFor(() => expect(backend.enabled).toBe(true));
  });

  it('shows no warning at 16 GB or more', async () => {
    backend.totalMemoryBytes = 16 * GIB;
    render(<VideoUnderstandingCard />);
    await toggle();
    expect(screen.queryByRole('alert')).toBeNull();
  });
});
