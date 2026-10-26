// @apelles/editor — unit tests for the Edit tab's readiness state machine
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

/** Two real project identity keys (B-083/D-203 — the store's one input is the
 *  open project's key, a `.chroma` path in the real app). */
const PROJECT_A = '/projects/a.chroma';
const PROJECT_B = '/projects/b.chroma';

beforeEach(() => {
  invokeMock.mockReset();
  // Back to a clean generation; `setOpenProject(null)` is the real reset
  // path, so use it rather than poking state directly.
  useEditorTimelineStore.getState().setOpenProject(null);
  useEditorTimelineStore.setState({ timeline: null, status: 'idle', error: null });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('project-open signal (B-034 / D-112)', () => {
  it('only "no project open" reports no project open — a failed fetch never does', async () => {
    invokeMock.mockRejectedValue('parse project.json: EOF while parsing a value');

    const store = useEditorTimelineStore.getState();
    store.setOpenProject(PROJECT_A);
    await vi.waitFor(() => expect(useEditorTimelineStore.getState().status).toBe('error'), {
      timeout: 5000,
    });

    const s = useEditorTimelineStore.getState();
    // The whole point: the fetch failed, and the store still knows perfectly
    // well that a project is open. `EditorTab` renders its "No project open"
    // screen off `projectOpen` alone, so this failure can no longer produce
    // that message — it produces a real error with the real backend text.
    expect(s.openProjectKey).toBe(PROJECT_A);
    expect(s.timeline).toBeNull();
    expect(s.error).toContain('EOF while parsing');
  });

  it('closing the project is the one thing that clears the open project', () => {
    useEditorTimelineStore.getState().setOpenProject(PROJECT_A);
    expect(useEditorTimelineStore.getState().openProjectKey).toBe(PROJECT_A);

    useEditorTimelineStore.getState().setOpenProject(null);
    const s = useEditorTimelineStore.getState();
    expect(s.openProjectKey).toBeNull();
    expect(s.status).toBe('idle');
    expect(s.timeline).toBeNull();
  });
});

// B-083/D-203 — the live report: `open_project("A")` while project B was open
// returned A's own real data, and `get_timeline` right afterwards still served
// B's timeline, silently, for the rest of the session. The structural fault:
// this store's one input was a boolean, and both sides of a project *switch*
// are `true`, so the switch was invisible to it. These assert that the input
// carries the project's identity and that a changed identity really does drop
// everything belonging to the outgoing project.
describe('switching projects (B-083 / D-203)', () => {
  /** `chroma_timeline_get`/`_list` answering for whichever project is "open"
   *  in the fake backend right now — the real commands both read through the
   *  Rust-side active project, so switching projects changes what they return
   *  without any argument changing. */
  let backendProject = 'A';
  function installBackend() {
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === 'chroma_timeline_get') return Promise.resolve(timelineNamed(backendProject));
      if (cmd === 'chroma_timeline_list') {
        return Promise.resolve([
          { id: `id-${backendProject}`, name: backendProject, duration: 100, active: true },
        ]);
      }
      return Promise.resolve(undefined);
    });
  }

  async function openA() {
    backendProject = 'A';
    installBackend();
    useEditorTimelineStore.getState().setOpenProject(PROJECT_A);
    await vi.waitFor(() => expect(useEditorTimelineStore.getState().status).toBe('ready'));
  }

  it('opening a DIFFERENT project loads THAT project’s timeline', async () => {
    await openA();
    expect(useEditorTimelineStore.getState().timeline?.name).toBe('A');

    backendProject = 'B';
    useEditorTimelineStore.getState().setOpenProject(PROJECT_B);
    await vi.waitFor(() => expect(useEditorTimelineStore.getState().timeline?.name).toBe('B'));

    const s = useEditorTimelineStore.getState();
    expect(s.openProjectKey).toBe(PROJECT_B);
    expect(s.status).toBe('ready');
    // the switcher's tab strip is per-project too — it must not still list A's
    await vi.waitFor(() => expect(useEditorTimelineStore.getState().timelines).toEqual([
      { id: 'id-B', name: 'B', duration: 100, active: true },
    ]));
  });

  it('never serves the outgoing project’s timeline while the new one loads', async () => {
    await openA();
    useEditorTimelineStore.setState({ playhead: 42, selection: [{ track: 0, id: 'a-clip' }] });

    backendProject = 'B';
    useEditorTimelineStore.getState().setOpenProject(PROJECT_B);

    // Synchronously, before any fetch can have resolved: A's state is gone
    // rather than left on screen (and readable by the MCP layer) under B's name.
    const s = useEditorTimelineStore.getState();
    expect(s.timeline).toBeNull();
    expect(s.status).toBe('loading');
    expect(s.playhead).toBe(0);
    expect(s.selection).toEqual([]);
    expect(s.timelines).toEqual([]);
  });

  it('re-opening the SAME project is a no-op, not a reload', async () => {
    await openA();
    // wait for the open's own `loadList()` too, so the baseline count below is
    // taken once the open path has genuinely finished issuing calls
    await vi.waitFor(() => expect(useEditorTimelineStore.getState().timelines).toHaveLength(1));
    const callsBefore = invokeMock.mock.calls.length;

    useEditorTimelineStore.getState().setOpenProject(PROJECT_A);
    await flush();

    expect(invokeMock.mock.calls.length).toBe(callsBefore);
    expect(useEditorTimelineStore.getState().timeline?.name).toBe('A');
  });

  it('a debounced save still pending for the old project never writes into the new one', async () => {
    // `_flushSave` reads `timeline` at FIRE time, and by the time this store
    // hears about a switch the backend already points at the incoming project
    // — so a surviving timer would have posted the OUTGOING project's timeline
    // into the incoming one. (Losing that last <400ms edit is B-080's own
    // race, tracked separately; writing it into the wrong project is not.)
    vi.useFakeTimers();
    await openA();
    useEditorTimelineStore.getState().applyOp({ kind: 'add_track', trackKind: 'video' });

    backendProject = 'B';
    useEditorTimelineStore.getState().setOpenProject(PROJECT_B);
    await vi.advanceTimersByTimeAsync(2000);

    expect(invokeMock.mock.calls.map((c) => c[0])).not.toContain('chroma_timeline_set');
  });
});

// B-080 — the live repro, reproduced here against a fake backend that mirrors
// the real `chroma_timeline_set`'s one load-bearing property: it writes onto
// whichever timeline is ACTIVE when it arrives, never onto the timeline the
// posted document came from. That is why a save left pending across a switch is
// not merely late — it is addressed to a document that is no longer there, and
// `setActiveTimeline`'s own `load()` has by then overwritten the only in-memory
// copy of the edit. The edit existed nowhere afterwards, with no error shown.
describe('a switch never outruns a pending save (B-080)', () => {
  /** The backend: one document per timeline id, plus which one is active.
   *  `chroma_timeline_set` writes into `active`, exactly like the real one. */
  let docs: Record<string, Timeline>;
  let active: string;
  /** every `chroma_timeline_set` that arrived, in order, as `[activeAtArrival,
   *  trackCountPosted]` — the ordering evidence the assertions rest on. */
  let writes: Array<[string, number]>;

  function timelineWithTracks(id: string, tracks: number): Timeline {
    return {
      id,
      name: id,
      rate: null,
      tracks: Array.from({ length: tracks }, () => ({ kind: 'video', clips: [] })),
    } as unknown as Timeline;
  }

  function installBackend() {
    docs = { A: timelineWithTracks('A', 1), B: timelineWithTracks('B', 1) };
    active = 'A';
    writes = [];
    invokeMock.mockImplementation((cmd: string, args?: Record<string, unknown>) => {
      switch (cmd) {
        case 'chroma_timeline_get':
          return Promise.resolve(docs[active]);
        case 'chroma_timeline_set': {
          const posted = args?.timeline as Timeline;
          writes.push([active, posted.tracks.length]);
          docs[active] = posted;
          return Promise.resolve(undefined);
        }
        case 'chroma_timeline_set_active':
          active = String(args?.id);
          return Promise.resolve(undefined);
        case 'chroma_timeline_create':
          docs.C = timelineWithTracks('C', 0);
          active = 'C';
          return Promise.resolve(docs.C);
        case 'chroma_timeline_list':
          return Promise.resolve(
            Object.keys(docs).map((id) => ({ id, name: id, duration: 0, active: id === active })),
          );
        default:
          return Promise.resolve(undefined);
      }
    });
  }

  beforeEach(async () => {
    installBackend();
    useEditorTimelineStore.getState().setOpenProject(PROJECT_A);
    await vi.waitFor(() => expect(useEditorTimelineStore.getState().timeline?.id).toBe('A'));
  });

  it('an edit made just before switching timelines reaches disk, on the timeline it was made on', async () => {
    // The exact live repro: edit, then switch WITHOUT waiting out the 400ms
    // debounce. Before the fix, the timer was left running, fired ~400ms later
    // against B's content, and A's added track was gone from both disk and
    // memory.
    useEditorTimelineStore.getState().applyOp({ kind: 'add_track', trackKind: 'video' });
    expect(useEditorTimelineStore.getState().timeline?.tracks).toHaveLength(2);

    const res = await useEditorTimelineStore.getState().setActiveTimeline('B');
    expect(res.ok).toBe(true);

    // The save landed, on A, BEFORE the switch — a two-track A is on "disk".
    expect(docs.A.tracks).toHaveLength(2);
    expect(writes).toEqual([['A', 2]]);
    // …and B is untouched by it.
    expect(docs.B.tracks).toHaveLength(1);
    expect(useEditorTimelineStore.getState().timeline?.id).toBe('B');
  });

  it('the flush is ordered BEFORE the switch command, not merely started alongside it', async () => {
    // `chroma_timeline_set` has no timeline id in it, so "both were sent" is
    // not good enough — the write has to arrive while A is still the active
    // document. This asserts the order of the two commands directly.
    useEditorTimelineStore.getState().applyOp({ kind: 'add_track', trackKind: 'video' });
    await useEditorTimelineStore.getState().setActiveTimeline('B');

    const order = invokeMock.mock.calls.map((c) => c[0] as string);
    expect(order.indexOf('chroma_timeline_set')).toBeGreaterThanOrEqual(0);
    expect(order.indexOf('chroma_timeline_set')).toBeLessThan(order.indexOf('chroma_timeline_set_active'));
  });

  it('creating a timeline flushes the outgoing one too', async () => {
    useEditorTimelineStore.getState().applyOp({ kind: 'add_track', trackKind: 'video' });
    const res = await useEditorTimelineStore.getState().createTimeline('C');

    expect(res.ok).toBe(true);
    expect(docs.A.tracks).toHaveLength(2); // A's edit persisted, on A
    expect(writes).toEqual([['A', 2]]);
    expect(useEditorTimelineStore.getState().timeline?.id).toBe('C');
  });

  it('no pending save means no extra write — the happy path is unchanged', async () => {
    vi.useFakeTimers();
    useEditorTimelineStore.getState().applyOp({ kind: 'add_track', trackKind: 'video' });
    await vi.advanceTimersByTimeAsync(1000); // let the ordinary debounce land
    expect(writes).toEqual([['A', 2]]);

    await useEditorTimelineStore.getState().setActiveTimeline('B');
    expect(writes).toEqual([['A', 2]]); // no second, redundant save
  });

  it('a switch is REFUSED — not silently completed — when the forced save fails', async () => {
    // The edit only exists in `timeline` at this point; letting the switch
    // proceed would overwrite it via `load()` and lose it for good, which is
    // the very bug. Refusing keeps it on screen and retryable.
    useEditorTimelineStore.getState().applyOp({ kind: 'add_track', trackKind: 'video' });
    const realImpl = invokeMock.getMockImplementation();
    invokeMock.mockImplementation((cmd: string, args?: Record<string, unknown>) =>
      cmd === 'chroma_timeline_set'
        ? Promise.reject('disk full')
        : (realImpl as (c: string, a?: Record<string, unknown>) => Promise<unknown>)(cmd, args),
    );

    const res = await useEditorTimelineStore.getState().setActiveTimeline('B');

    expect(res.ok).toBe(false);
    expect(res.error).toContain('disk full');
    // Never issued the switch, and the edit is still in memory.
    expect(invokeMock.mock.calls.map((c) => c[0])).not.toContain('chroma_timeline_set_active');
    expect(useEditorTimelineStore.getState().timeline?.id).toBe('A');
    expect(useEditorTimelineStore.getState().timeline?.tracks).toHaveLength(2);
  });

  it('waits out a save that is already in flight, not just one still on the timer', async () => {
    // The window a timer-only cancel would race straight through: the debounce
    // has fired, the invoke is out, nothing is "pending" any more — and the
    // write has still not reached disk.
    const gate = deferred<undefined>();
    const realImpl = invokeMock.getMockImplementation() as (
      c: string,
      a?: Record<string, unknown>,
    ) => Promise<unknown>;
    invokeMock.mockImplementation((cmd: string, args?: Record<string, unknown>) =>
      cmd === 'chroma_timeline_set'
        ? gate.promise.then(() => realImpl(cmd, args))
        : realImpl(cmd, args),
    );

    vi.useFakeTimers();
    useEditorTimelineStore.getState().applyOp({ kind: 'add_track', trackKind: 'video' });
    // Let the ordinary 400ms debounce fire for real, so the save is genuinely
    // in flight (and `saveTimer` genuinely null) when the switch arrives.
    await vi.advanceTimersByTimeAsync(500);
    expect(writes).toEqual([]); // out, but gated — nothing on "disk" yet

    const switching = useEditorTimelineStore.getState().setActiveTimeline('B');
    await vi.advanceTimersByTimeAsync(1);
    // The switch has NOT run ahead while the write is stuck in flight.
    expect(invokeMock.mock.calls.map((c) => c[0])).not.toContain('chroma_timeline_set_active');

    gate.resolve(undefined);
    expect(await switching).toEqual({ ok: true });
    expect(writes).toEqual([['A', 2]]);
    expect(docs.A.tracks).toHaveLength(2);
  });

  it('an undo’s immediate save is waited out by a switch too', async () => {
    // `restoreSnapshot` bypasses the debounce and posts straight away — same
    // "addressed to whichever timeline is active" hazard, so it is tracked as
    // an in-flight save exactly like a debounced one.
    const gate = deferred<undefined>();
    const realImpl = invokeMock.getMockImplementation() as (
      c: string,
      a?: Record<string, unknown>,
    ) => Promise<unknown>;
    invokeMock.mockImplementation((cmd: string, args?: Record<string, unknown>) =>
      cmd === 'chroma_timeline_set'
        ? gate.promise.then(() => realImpl(cmd, args))
        : realImpl(cmd, args),
    );

    useEditorTimelineStore.getState().restoreSnapshot(timelineWithTracks('A', 3));
    const switching = useEditorTimelineStore.getState().setActiveTimeline('B');
    await flush();
    expect(invokeMock.mock.calls.map((c) => c[0])).not.toContain('chroma_timeline_set_active');

    gate.resolve(undefined);
    expect(await switching).toEqual({ ok: true });
    expect(writes).toEqual([['A', 3]]);
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

    // Set the key directly rather than via `setOpenProject`, so the retry
    // ladder doesn't also consume mocked responses — this test is about the
    // ordering guarantee alone.
    useEditorTimelineStore.setState({ openProjectKey: PROJECT_A });
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

    useEditorTimelineStore.setState({ openProjectKey: PROJECT_A });
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

    useEditorTimelineStore.getState().setOpenProject(PROJECT_A);

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
    // `setOpenProject` is idempotent per key (guards on
    // `get().openProjectKey === key`, see its own doc) — it has to genuinely
    // transition open→closed to hit the reset branch, so mark it open first
    // rather than relying on the outer `beforeEach`'s already-closed default.
    useEditorTimelineStore.setState({
      openProjectKey: PROJECT_A,
      selection: [{ track: 0, id: 'a' }],
      selectedGap: { track: 1, frame: 10 },
    });
    useEditorTimelineStore.getState().setOpenProject(null);
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

describe('a refetch never replaces a newer local edit with an older backend copy (B-272)', () => {
  function tracks(n: number): Timeline {
    return {
      id: 'A',
      name: 'A',
      rate: null,
      tracks: Array.from({ length: n }, () => ({ kind: 'video', clips: [] })),
    } as unknown as Timeline;
  }

  beforeEach(() => {
    useEditorTimelineStore.setState({ openProjectKey: PROJECT_A, timeline: tracks(1), status: 'ready' });
  });

  it('keeps an edit whose save is still on its debounce timer when a refetch answers', async () => {
    // The backend still holds the old document (the save has not been sent).
    invokeMock.mockImplementation((cmd: string) =>
      cmd === 'chroma_timeline_get' ? Promise.resolve(tracks(1)) : Promise.resolve(undefined),
    );
    vi.useFakeTimers();
    useEditorTimelineStore.getState().applyOp({ kind: 'add_track', trackKind: 'video' });
    await useEditorTimelineStore.getState().load(); // e.g. the window `focus` refetch
    expect(useEditorTimelineStore.getState().timeline?.tracks).toHaveLength(2);
  });

  it('keeps an edit made while the refetch was in flight', async () => {
    const stale = deferred<Timeline>();
    invokeMock.mockImplementation((cmd: string) =>
      cmd === 'chroma_timeline_get' ? stale.promise : Promise.resolve(undefined),
    );
    vi.useFakeTimers();
    const loading = useEditorTimelineStore.getState().load();
    useEditorTimelineStore.getState().applyOp({ kind: 'add_track', trackKind: 'video' });
    await vi.advanceTimersByTimeAsync(500); // its save has now been sent AND finished
    stale.resolve(tracks(1)); // the answer was computed before the edit
    await loading;
    expect(useEditorTimelineStore.getState().timeline?.tracks).toHaveLength(2);
  });

  it('still takes the backend copy when nothing is owed (a focus refetch picks up outside changes)', async () => {
    invokeMock.mockImplementation((cmd: string) =>
      cmd === 'chroma_timeline_get' ? Promise.resolve(tracks(3)) : Promise.resolve(undefined),
    );
    await useEditorTimelineStore.getState().load();
    expect(useEditorTimelineStore.getState().timeline?.tracks).toHaveLength(3);
  });

  it('an undo’s own reconcile refetch still lands (and bumps savedVersion)', async () => {
    invokeMock.mockImplementation((cmd: string) =>
      cmd === 'chroma_timeline_get' ? Promise.resolve(tracks(4)) : Promise.resolve(undefined),
    );
    const before = useEditorTimelineStore.getState().savedVersion;
    useEditorTimelineStore.getState().restoreSnapshot(tracks(4));
    await flush();
    expect(useEditorTimelineStore.getState().savedVersion).toBeGreaterThan(before);
    expect(useEditorTimelineStore.getState().timeline?.tracks).toHaveLength(4);
  });
});
