// @vitest-environment jsdom
/**
 * AgentActivityDock on real DOM — the chrome-bar button + popover (B-341;
 * this file began as B-159's "Hide actually hides" proof, whose dismissal
 * machinery the popover retired).
 *
 * `app/`'s vitest workspace runs `environment: 'node'`; this file overrides
 * that with the `// @vitest-environment jsdom` pragma + `@testing-library/react`
 * pattern `@apelles/player`'s `Player.rate.dom.test.tsx` uses.
 *
 * Store-reset pattern matches `useSessionStore.test.ts`: a fresh snapshot of
 * the singleton stores this component reads — `useAgentStore`, `useShellStore`
 * and `@apelles/history`'s `useHistoryStore` — before every test.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

import { runAsAgent, useHistoryStore } from '@apelles/history';
import { useShellStore } from '@apelles/shell';

import { useAgentStore } from '../../store/useAgentStore';
import AgentActivityDock from './AgentActivityDock';

const AGENT_STORE_INITIAL = useAgentStore.getState();
const HISTORY_STORE_INITIAL = useHistoryStore.getState();
const SHELL_STORE_INITIAL = useShellStore.getState();

beforeEach(() => {
  useAgentStore.setState({
    ...AGENT_STORE_INITIAL,
    activity: [],
    pendingHumanRequest: null,
    activeShotKey: null,
    shotFeeds: {},
    activitySeenTs: 0,
  });
  useHistoryStore.setState({ ...HISTORY_STORE_INITIAL, undoStack: [], redoStack: [] });
  useShellStore.setState({ ...SHELL_STORE_INITIAL, agentActivityOpen: false });
});

afterEach(cleanup);

/** Push one Edit/Motion op onto the shared undo stack, stamped `source:
 *  'agent'` via `runAsAgent` — the D-298 half of the feed (read straight off
 *  `@apelles/history`, not through `useAgentStore.recordActivity`) that
 *  exercises the real re-show path: nothing here ever calls
 *  `recordActivity`, so if re-showing depended on that action firing, this
 *  would catch it. `tab: 'edit'` (not `'colorist'`) so the dock's own filter
 *  (D-298) counts it. */
async function pushAgentOp(label: string) {
  await runAsAgent(() =>
    useHistoryStore.getState().push({ tab: 'edit', label, undo: () => {}, redo: () => {} }),
  );
}

const BUTTON = { name: /^Agent activity/ };
const badge = () => document.querySelector('[data-chroma-agent-activity-badge]');
const popover = () => document.querySelector('[data-chroma-agent-activity]');

describe('AgentActivityDock (B-341)', () => {
  it('renders the button with no badge and no popover when there is no activity', () => {
    render(<AgentActivityDock />);
    expect(screen.getByRole('button', BUTTON)).toBeTruthy();
    expect(badge()).toBeNull();
    expect(popover()).toBeNull();
  });

  it('new activity only bumps the badge; it never opens the popover', async () => {
    render(<AgentActivityDock />);
    await act(() => pushAgentOp('Trim clip (start)'));
    expect(badge()?.textContent).toBe('1');
    await act(() => pushAgentOp('Split clip'));
    expect(badge()?.textContent).toBe('2');
    expect(popover()).toBeNull();
    expect(useShellStore.getState().agentActivityOpen).toBe(false);
    // and a Colorist-side row bumps it the same way
    act(() => {
      useAgentStore.getState().recordActivity({
        id: 'a1', op: 'set_primary', args: {}, ts: Date.now() + 1, summary: 'primary: exposure +0.3',
        frame: null, historyIndexBefore: 0, adjustmentsBefore: {} as never, adjustmentsAfter: {} as never,
        diff: [], undone: false,
      });
    });
    expect(badge()?.textContent).toBe('3');
    expect(popover()).toBeNull();
  });

  it('clicking the button opens the list and clears the badge; clicking again closes it', async () => {
    await act(() => pushAgentOp('Trim clip (start)'));
    render(<AgentActivityDock />);
    expect(badge()?.textContent).toBe('1');

    fireEvent.click(screen.getByRole('button', BUTTON));
    await waitFor(() => expect(popover()).not.toBeNull());
    expect(screen.getByText('Trim clip (start)')).toBeTruthy();
    expect(badge()).toBeNull();

    fireEvent.click(screen.getByRole('button', BUTTON));
    await waitFor(() => expect(popover()).toBeNull());
    // seen while open: closing does not resurrect the badge
    expect(badge()).toBeNull();
  });

  it('rows arriving while the popover is open do not leave a badge after it closes', async () => {
    render(<AgentActivityDock />);
    fireEvent.click(screen.getByRole('button', BUTTON));
    await waitFor(() => expect(popover()).not.toBeNull());
    await act(() => pushAgentOp('Split clip'));
    expect(screen.getByText('Split clip')).toBeTruthy();
    act(() => useShellStore.getState().setAgentActivityOpen(false));
    await waitFor(() => expect(popover()).toBeNull());
    expect(badge()).toBeNull();
  });

  it('Escape closes it', async () => {
    render(<AgentActivityDock />);
    fireEvent.click(screen.getByRole('button', BUTTON));
    await waitFor(() => expect(popover()).not.toBeNull());
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });
    await waitFor(() => expect(popover()).toBeNull());
    expect(useShellStore.getState().agentActivityOpen).toBe(false);
  });

  it('the close (X) button closes it', async () => {
    render(<AgentActivityDock />);
    fireEvent.click(screen.getByRole('button', BUTTON));
    await waitFor(() => expect(popover()).not.toBeNull());
    fireEvent.click(screen.getByRole('button', { name: 'Close agent activity' }));
    await waitFor(() => expect(popover()).toBeNull());
  });

  it('Clear empties the Colorist feed', async () => {
    act(() => {
      useAgentStore.getState().recordActivity({
        id: 'a1', op: 'set_primary', args: {}, ts: Date.now(), summary: 'primary: exposure +0.3',
        frame: null, historyIndexBefore: 0, adjustmentsBefore: {} as never, adjustmentsAfter: {} as never,
        diff: [], undone: false,
      });
    });
    useShellStore.setState({ agentActivityOpen: true });
    render(<AgentActivityDock />);
    await waitFor(() => expect(screen.getByText('primary: exposure +0.3')).toBeTruthy());
    fireEvent.click(screen.getByTitle(/^Clear the grade feed/));
    expect(screen.queryByText('primary: exposure +0.3')).toBeNull();
    expect(screen.getByText('No agent activity yet.')).toBeTruthy();
  });

  it('is the shell flag that opens it, so a debug op can drive the same popover', async () => {
    render(<AgentActivityDock />);
    act(() => useShellStore.getState().setAgentActivityOpen(true));
    await waitFor(() => expect(popover()).not.toBeNull());
  });

  it('renders nothing positioned over the page while closed', async () => {
    await act(() => pushAgentOp('Trim clip (start)'));
    const { container } = render(<AgentActivityDock />);
    expect(popover()).toBeNull();
    expect(screen.queryByText('Agent activity')).toBeNull();
    expect(container.querySelector('.fixed')).toBeNull();
  });

  it('a pending request_human turns the button into an attention state, without opening', async () => {
    render(<AgentActivityDock />);
    act(() => {
      useAgentStore.getState().postHumanRequest('need your eyes on the shadows', null);
    });
    expect(badge()?.textContent).toBe('!');
    expect(popover()).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /asking for you/ }));
    await waitFor(() => expect(screen.getByText('The agent is asking for you')).toBeTruthy());
    fireEvent.click(screen.getByText('Resume agent'));
    expect(screen.queryByText('The agent is asking for you')).toBeNull();
  });
});
