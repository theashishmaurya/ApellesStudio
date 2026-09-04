// @chroma/editor — unit tests for the Edit tab's readiness state machine
// (B-034 / D-112).
//
// These are regression tests for the *class* of bug that produced a false
// "No project open" screen five separate times with five different underlying
// causes (B-004, B-025, B-031, B-032, B-034). The common structural fault was
// never in any one of those causes: it was that this store inferred "no
// project is open" from "a fetch failed", had no ordering guarantee between
// concurrent fetches, and had no way to recover from a fetch whose response
// never arrived. Each property below is one of those holes, asserted shut.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const invokeMock = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...args: unknown[]) => invokeMock(...args) }));

const { useEditorTimelineStore } = await import('./timelineStore');
import type { Timeline } from './timeline';

function timelineNamed(name: string): Timeline {
  return { id: `id-${name}`, name, rate: null, tracks: [] } as unknown as Timeline;
}

/** A promise plus the handles to settle it whenever the test chooses — the
 *  only way to actually interleave two in-flight loads deterministically. */
function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Let queued microtasks (and any zero-delay timers) drain. */
const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  invokeMock.mockReset();
  // Back to a clean generation; `setProjectOpen(false)` is the real reset
  // path, so use it rather than poking state directly.
  useEditorTimelineStore.getState().setProjectOpen(false);
  useEditorTimelineStore.setState({ timeline: null, status: 'idle', error: null });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('project-open signal (B-034 / D-112)', () => {
  it('only "no project open" reports no project open — a failed fetch never does', async () => {
    invokeMock.mockRejectedValue('parse project.json: EOF while parsing a value');

    const store = useEditorTimelineStore.getState();
    store.setProjectOpen(true);
    await vi.waitFor(() => expect(useEditorTimelineStore.getState().status).toBe('error'), {
      timeout: 5000,
    });

    const s = useEditorTimelineStore.getState();
    // The whole point: the fetch failed, and the store still knows perfectly
    // well that a project is open. `EditorTab` renders its "No project open"
    // screen off `projectOpen` alone, so this failure can no longer produce
    // that message — it produces a real error with the real backend text.
    expect(s.projectOpen).toBe(true);
    expect(s.timeline).toBeNull();
    expect(s.error).toContain('EOF while parsing');
  });

  it('closing the project is the one thing that clears projectOpen', () => {
    useEditorTimelineStore.getState().setProjectOpen(true);
    expect(useEditorTimelineStore.getState().projectOpen).toBe(true);

    useEditorTimelineStore.getState().setProjectOpen(false);
    const s = useEditorTimelineStore.getState();
    expect(s.projectOpen).toBe(false);
    expect(s.status).toBe('idle');
    expect(s.timeline).toBeNull();
  });
});

describe('concurrent load ordering (B-034 / D-112)', () => {
  it('a slow stale FAILURE cannot overwrite a newer success', async () => {
    // The exact live shape: a `load()` already in flight (from the tab's own
    // mount, or an OS window-focus event) fails late, after a later `load()`
    // triggered by the project actually opening has already succeeded.
    const stale = deferred<Timeline>();
    const fresh = deferred<Timeline>();
    invokeMock.mockReturnValueOnce(stale.promise).mockReturnValueOnce(fresh.promise);

    // Set the flag directly rather than via `setProjectOpen`, so the retry
    // ladder doesn't also consume mocked responses — this test is about the
    // ordering guarantee alone.
    useEditorTimelineStore.setState({ projectOpen: true });
    const store = useEditorTimelineStore.getState();
    const staleLoad = store.load();
    const freshLoad = store.load();

    fresh.resolve(timelineNamed('real'));
    await freshLoad;
    expect(useEditorTimelineStore.getState().status).toBe('ready');

    stale.reject('no project open — open one in the Colorist tab');
    await staleLoad;
    await flush();

    const s = useEditorTimelineStore.getState();
    expect(s.status).toBe('ready');
    expect(s.timeline?.name).toBe('real');
    expect(s.error).toBeNull();
  });

  it('a slow stale SUCCESS cannot overwrite a newer failure either', async () => {
    const stale = deferred<Timeline>();
    const fresh = deferred<Timeline>();
    invokeMock.mockReturnValueOnce(stale.promise).mockReturnValueOnce(fresh.promise);

    useEditorTimelineStore.setState({ projectOpen: true });
    const store = useEditorTimelineStore.getState();
    const staleLoad = store.load();
    const freshLoad = store.load();

    fresh.reject('boom');
    await freshLoad;
    stale.resolve(timelineNamed('outdated'));
    await staleLoad;
    await flush();

    const s = useEditorTimelineStore.getState();
    expect(s.status).toBe('error');
    expect(s.timeline).toBeNull();
  });
});

describe('recovery (B-034 / D-112)', () => {
  it('a transient failure right after open recovers on its own, with no user action', async () => {
    // D-085's one-shot 500ms retry only ever covered a single failure at a
    // single delay. The ladder keeps trying, briefly and finitely.
    invokeMock
      .mockRejectedValueOnce('no project open — open one in the Colorist tab')
      .mockRejectedValueOnce('no project open — open one in the Colorist tab')
      .mockResolvedValue(timelineNamed('recovered'));

    useEditorTimelineStore.getState().setProjectOpen(true);

    await vi.waitFor(() => expect(useEditorTimelineStore.getState().status).toBe('ready'), {
      timeout: 5000,
    });
    expect(useEditorTimelineStore.getState().timeline?.name).toBe('recovered');
    expect(useEditorTimelineStore.getState().error).toBeNull();
  });

  it('a lost IPC response times out instead of stranding the tab forever', async () => {
    // Tauri drops a pending invoke's callback when the page reloads under it
    // ("Couldn't find callback id N…", seen repeatedly in the owner's own dev
    // log). That promise then never settles. Without a ceiling, `load()`
    // never finishes and the tab sits on a spinner or a stale screen for the
    // rest of the session.
    vi.useFakeTimers();
    invokeMock.mockReturnValue(new Promise(() => {}));

    const load = useEditorTimelineStore.getState().load();
    await vi.advanceTimersByTimeAsync(9000);
    await load;

    const s = useEditorTimelineStore.getState();
    expect(s.status).toBe('error');
    expect(s.error).toContain('lost IPC response');
  });
});

// D-118 — `selection`/`selectedGap` moved here from `TimelinePane.tsx`'s own
// local `useState` so `EditorInspectorPanel` (now a sibling component, not
// nested inside `TimelinePane`) can read the same selection. These assert
// the two real behaviors that used to be implicit in two co-located
// `useState` calls and now have to hold across a store instead: mutual
// exclusivity, and that `setSelection` still accepts a `useState`-style
// updater (`TimelinePane`'s pre-existing call sites — shift-click range
// extend, cmd-click toggle — all use the functional form).
describe('selection (D-118)', () => {
  beforeEach(() => {
    useEditorTimelineStore.setState({ selection: [], selectedGap: null });
  });

  it('selecting a clip clears any selected gap', () => {
    useEditorTimelineStore.setState({ selectedGap: { track: 0, frame: 40 } });
    useEditorTimelineStore.getState().setSelection([{ track: 0, id: 'a' }]);
    expect(useEditorTimelineStore.getState().selectedGap).toBeNull();
  });

  it('selecting a gap clears any clip selection', () => {
    useEditorTimelineStore.setState({ selection: [{ track: 0, id: 'a' }] });
    useEditorTimelineStore.getState().setSelectedGap({ track: 0, frame: 40 });
    expect(useEditorTimelineStore.getState().selection).toEqual([]);
  });

  it('deselecting a gap (null) leaves the clip selection alone', () => {
    useEditorTimelineStore.setState({ selection: [{ track: 0, id: 'a' }], selectedGap: null });
    useEditorTimelineStore.getState().setSelectedGap(null);
    expect(useEditorTimelineStore.getState().selection).toEqual([{ track: 0, id: 'a' }]);
  });

  it('setSelection accepts a useState-style updater reading the real in-store prev value', () => {
    useEditorTimelineStore.getState().setSelection([{ track: 0, id: 'a' }]);
    useEditorTimelineStore.getState().setSelection((prev) => [...prev, { track: 0, id: 'b' }]);
    expect(useEditorTimelineStore.getState().selection).toEqual([
      { track: 0, id: 'a' },
      { track: 0, id: 'b' },
    ]);
  });

  it('closing the project resets both selection and selectedGap', () => {
    // `setProjectOpen` is idempotent (guards on `get().projectOpen === open`,
    // see its own doc) — it has to genuinely transition open→closed to hit
    // the reset branch, so mark it open first rather than relying on the
    // outer `beforeEach`'s already-closed default.
    useEditorTimelineStore.setState({
      projectOpen: true,
      selection: [{ track: 0, id: 'a' }],
      selectedGap: { track: 1, frame: 10 },
    });
    useEditorTimelineStore.getState().setProjectOpen(false);
    const s = useEditorTimelineStore.getState();
    expect(s.selection).toEqual([]);
    expect(s.selectedGap).toBeNull();
  });
});

describe('auto-decommission empty tracks — selection follows the prune (owner, live)', () => {
  function threeTrackTimeline(): Timeline {
    return {
      id: 't1',
      name: 'Timeline',
      tracks: [
        { kind: 'video', clips: [{ id: 'a', name: 'A', source_path: '/a.mov', source_start: 0, duration: 100, source_len: 100, start_frame: 0 }] },
        { kind: 'video', clips: [{ id: 'b', name: 'B', source_path: '/b.mov', source_start: 0, duration: 100, source_len: 100, start_frame: 0 }] },
        { kind: 'video', clips: [{ id: 'c', name: 'C', source_path: '/c.mov', source_start: 0, duration: 100, source_len: 100, start_frame: 0 }] },
      ],
    } as unknown as Timeline;
  }

  beforeEach(() => {
    useEditorTimelineStore.setState({ timeline: threeTrackTimeline(), selection: [], selectedGap: null });
  });

  it('removing the sole selected clip on track 0 clears its own selection and shifts a later track-index selection down', () => {
    useEditorTimelineStore.setState({
      selection: [
        { track: 0, id: 'a' }, // lives on the track about to be pruned
        { track: 2, id: 'c' }, // lives two tracks later — must become track 1
      ],
    });
    useEditorTimelineStore.getState().applyOp({ kind: 'remove', track: 0, clip: 0 });
    const s = useEditorTimelineStore.getState();
    expect(s.timeline?.tracks).toHaveLength(2); // track 0 pruned
    expect(s.selection).toEqual([{ track: 1, id: 'c' }]); // 'a' gone with its track, 'c' shifted 2->1
  });

  // D-129 — this used to assert that a gap on a LATER track shifted down by
  // one. That remap was only ever correct because exactly one track could be
  // pruned per op, at an index the op itself named. A linked A/V delete can
  // prune two tracks at once, at indices the op never names, so the remap has
  // no sound basis any more and any change in track count now simply clears
  // the gap. Deliberate contract change, not a regression: a gap selection is
  // transient and trivially re-made by clicking, and a silently-wrong track
  // index is far worse than none. Clip selections keep following the prune
  // exactly as before (the test above) — they have stable ids to follow.
  it('any track prune clears a selected gap outright — no index remap to get wrong', () => {
    useEditorTimelineStore.setState({ selection: [], selectedGap: { track: 2, frame: 0 } });
    useEditorTimelineStore.getState().applyOp({ kind: 'remove', track: 0, clip: 0 });
    expect(useEditorTimelineStore.getState().timeline?.tracks).toHaveLength(2);
    expect(useEditorTimelineStore.getState().selectedGap).toBeNull();
  });

  // D-129 — a dropped clip's audio half APPENDS an audio track. Appending
  // renumbers nothing, so neither selection may be disturbed by it (the
  // clear above is gated on the list shrinking, not merely changing).
  it('adding a track leaves both selections alone', () => {
    useEditorTimelineStore.setState({
      selection: [{ track: 2, id: 'c' }],
      selectedGap: null,
    });
    useEditorTimelineStore.getState().applyOp({ kind: 'add_track', trackKind: 'audio' });
    const s = useEditorTimelineStore.getState();
    expect(s.timeline?.tracks).toHaveLength(4);
    expect(s.selection).toEqual([{ track: 2, id: 'c' }]);
  });

  it('a selected gap survives an op that prunes nothing', () => {
    const t = threeTrackTimeline();
    t.tracks[0].clips.push({ id: 'a2', name: 'A2', source_path: '/a2.mov', source_start: 0, duration: 50, source_len: 50, start_frame: 100 } as never);
    useEditorTimelineStore.setState({ timeline: t, selection: [], selectedGap: { track: 2, frame: 0 } });
    useEditorTimelineStore.getState().applyOp({ kind: 'remove', track: 0, clip: 0 }); // track 0 keeps 'a2'
    expect(useEditorTimelineStore.getState().timeline?.tracks).toHaveLength(3);
    expect(useEditorTimelineStore.getState().selectedGap).toEqual({ track: 2, frame: 0 });
  });

  /** D-129 — the real reason the remap had to go: one `remove` on a linked
   *  pair empties (and prunes) BOTH its tracks, and the surviving selection
   *  still has to end up pointing at the right track. */
  it('a linked A/V delete prunes two tracks at once and selection still lands correctly', () => {
    const linked = {
      id: 't1',
      name: 'Timeline',
      tracks: [
        { kind: 'video', clips: [{ id: 'v', name: 'V', source_path: '/v.mov', source_start: 0, duration: 100, source_len: 100, start_frame: 0, link_group: 'g1' }] },
        { kind: 'audio', clips: [{ id: 'va', name: 'V', source_path: '/v.mov', source_start: 0, duration: 100, source_len: 100, start_frame: 0, link_group: 'g1' }] },
        { kind: 'video', clips: [{ id: 'c', name: 'C', source_path: '/c.mov', source_start: 0, duration: 100, source_len: 100, start_frame: 0 }] },
      ],
    } as unknown as Timeline;
    useEditorTimelineStore.setState({ timeline: linked, selection: [{ track: 2, id: 'c' }], selectedGap: null });
    useEditorTimelineStore.getState().applyOp({ kind: 'remove', track: 0, clip: 0 });
    const s = useEditorTimelineStore.getState();
    expect(s.timeline?.tracks).toHaveLength(1); // BOTH the video and audio track pruned
    expect(s.selection).toEqual([{ track: 0, id: 'c' }]); // followed 2 -> 0, not 2 -> 1
  });

  it('a selection on a track BEFORE the pruned one is untouched', () => {
    useEditorTimelineStore.setState({ selection: [{ track: 0, id: 'a' }] });
    // empty track 2's only clip by moving it onto track 1 (cross-track)
    useEditorTimelineStore.getState().applyOp({ kind: 'move', fromTrack: 2, toTrack: 1, clip: 0, startFrame: 200 });
    expect(useEditorTimelineStore.getState().timeline?.tracks).toHaveLength(2);
    expect(useEditorTimelineStore.getState().selection).toEqual([{ track: 0, id: 'a' }]); // unaffected
  });

  it('does not touch selection when no track was actually pruned (track still has a clip)', () => {
    const t = threeTrackTimeline();
    t.tracks[0].clips.push({ id: 'a2', name: 'A2', source_path: '/a2.mov', source_start: 0, duration: 50, source_len: 50, start_frame: 100 } as never);
    useEditorTimelineStore.setState({ timeline: t, selection: [{ track: 2, id: 'c' }] });
    useEditorTimelineStore.getState().applyOp({ kind: 'remove', track: 0, clip: 0 }); // track 0 still has 'a2' left
    const s = useEditorTimelineStore.getState();
    expect(s.timeline?.tracks).toHaveLength(3);
    expect(s.selection).toEqual([{ track: 2, id: 'c' }]); // untouched — nothing pruned
  });
});
