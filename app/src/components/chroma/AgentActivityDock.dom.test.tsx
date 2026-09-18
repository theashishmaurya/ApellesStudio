// @vitest-environment jsdom
/**
 * AgentActivityDock on real DOM (B-159).
 *
 * `app/`'s vitest workspace runs `environment: 'node'` (nothing here mounted
 * a component before this); this file overrides that with the same
 * `// @vitest-environment jsdom` pragma + `@testing-library/react` pattern
 * `@apelles/player`'s own `Player.rate.dom.test.tsx` already uses for exactly
 * this reason — a store-level test cannot see a button that renders but does
 * nothing, which is precisely what B-159 was: the "Hide" (X) button called
 * `setFeedOpen(false)`, silently duplicating the caret-toggle beside it, so
 * the card never visibly closed.
 *
 * Store-reset pattern matches `useSessionStore.test.ts`: a fresh snapshot of
 * both singleton stores this component reads — `useAgentStore` and
 * `@apelles/history`'s `useHistoryStore` — before every test.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';

import { runAsAgent, useHistoryStore } from '@apelles/history';

import { useAgentStore } from '../../store/useAgentStore';
import AgentActivityDock from './AgentActivityDock';

const AGENT_STORE_INITIAL = useAgentStore.getState();
const HISTORY_STORE_INITIAL = useHistoryStore.getState();

beforeEach(() => {
  useAgentStore.setState({
    ...AGENT_STORE_INITIAL,
    activity: [],
    pendingHumanRequest: null,
    feedOpen: true,
    activeShotKey: null,
    shotFeeds: {},
    dockDismissed: false,
    dismissedAtRowKey: null,
  });
  useHistoryStore.setState({ ...HISTORY_STORE_INITIAL, undoStack: [], redoStack: [] });
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

const HIDE_TITLE = 'Hide (reappears on new activity)';

describe('AgentActivityDock (B-159)', () => {
  it('renders nothing with no activity and no pending request', () => {
    render(<AgentActivityDock />);
    expect(screen.queryByText('Agent activity')).toBeNull();
  });

  it('shows the card once there is an activity row', async () => {
    await act(() => pushAgentOp('Trim clip (start)'));
    render(<AgentActivityDock />);
    expect(screen.getByText('Agent activity')).toBeTruthy();
  });

  it('clicking Hide actually hides the dock (the bug: it used to no-op)', async () => {
    await act(() => pushAgentOp('Trim clip (start)'));
    render(<AgentActivityDock />);
    expect(screen.getByText('Agent activity')).toBeTruthy();

    fireEvent.click(screen.getByTitle(HIDE_TITLE));

    expect(screen.queryByText('Agent activity')).toBeNull();
  });

  it('re-shows the dock the moment a new activity item arrives after a dismiss', async () => {
    await act(() => pushAgentOp('Trim clip (start)'));
    render(<AgentActivityDock />);
    fireEvent.click(screen.getByTitle(HIDE_TITLE));
    expect(screen.queryByText('Agent activity')).toBeNull();

    await act(() => pushAgentOp('Split clip'));

    expect(screen.getByText('Agent activity')).toBeTruthy();
    // both rows are still there — dismissing never dropped the first one.
    expect(screen.getByText('2')).toBeTruthy();
  });

  it('stays hidden across a re-render with no new activity (not a dismiss-forever, but not a flicker either)', async () => {
    await act(() => pushAgentOp('Trim clip (start)'));
    const { rerender } = render(<AgentActivityDock />);
    fireEvent.click(screen.getByTitle(HIDE_TITLE));

    rerender(<AgentActivityDock />);

    expect(screen.queryByText('Agent activity')).toBeNull();
  });

  it('leaves the request_human banner visible even while the activity card is dismissed', async () => {
    await act(() => pushAgentOp('Trim clip (start)'));
    render(<AgentActivityDock />);
    fireEvent.click(screen.getByTitle(HIDE_TITLE));
    expect(screen.queryByText('Agent activity')).toBeNull();

    act(() => {
      useAgentStore.getState().postHumanRequest('need your eyes on the shadows', null);
    });

    expect(screen.getByText('The agent is asking for you')).toBeTruthy();
    // the activity card itself is still dismissed — only the banner is back.
    expect(screen.queryByText('Agent activity')).toBeNull();
  });
});
