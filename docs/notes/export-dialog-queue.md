# notes/export-dialog-queue.md — the Edit tab's Export button/dialog/queue (D-198)

See `docs/08-decisions.md` D-198 for the full context/options/verification writeup.
This note is the worked-out shape, for anyone extending `EditorExportDialog.tsx`/
`exportQueueStore.ts` later.

## The one-implementation rule

```
                       ┌──────────────────────────┐
   MCP editor_export ──┤                          │
                       │   editorExport.ts         │
   Export dialog's    ─┤   compileEditorExportArgs │
   "Add to queue"      │   runEditorExport         │
                       │   runCompiledExport        │
   exportQueueStore   ─┤                          │
   .enqueue            └──────────────────────────┘
```

`compileEditorExportArgs(args)` is the ONLY place that turns a loose args object
into a validated, real `buildExportFfmpegArgs` call (including resolving D-197's
`hasAudioOverrides` from the media pool). `runEditorExport` is that plus the actual
`chroma_run_ffmpeg` invoke, in one call — what the MCP op needs. `runCompiledExport`
is the invoke alone, for a queue job whose argv was already compiled at enqueue
time. `useEditorControl.ts`'s `editor_export` op is now a one-line delegate:

```ts
editor_export: (a) => runEditorExport(a ?? {}),
```

There is no second copy of the validation or the compile call anywhere. A bug fix or
a new export-time option added to `compileEditorExportArgs` reaches BOTH the MCP tool
and the GUI dialog automatically.

## The queue: real, sequential, live

`exportQueueStore.ts` is a module-level zustand store (same "reachable via
`.getState()`, survives the dialog closing" shape `useEditorTimelineStore`/
`useMediaUnderstandingStore` already use).

```ts
enqueue(name, exportArgs):
  compiled = compileEditorExportArgs(exportArgs)   // real snapshot, right now
  if error -> return it, queue untouched
  push { status: 'queued', args: compiled.args, ... }
  runNext()

runNext():
  if any job is 'running' -> do nothing (one at a time)
  next = first 'queued' job (FIFO)
  if none -> do nothing
  mark next 'running'
  runCompiledExport(next.args)
    .then/catch -> mark next 'done' or 'failed', with real stderr on failure
    .finally -> runNext()   // cascade
```

Job 2 provably cannot start before job 1 settles (no `Promise.all`, no separate
timer) — `runNext`'s own `if (jobs.some(j => j.status === 'running')) return;` guard
is the entire mechanism, and it's called again in `.finally` after every settle, so
the cascade is automatic and needs no external poll. `exportQueueStore.test.ts` proves
this with a `deferred()` promise held open by hand: job 2 stays `'queued'` (ffmpeg
invoked exactly once) for as long as job 1's promise is unresolved, and job 2 starts
the instant it resolves.

**Why enqueue-time compilation, not run-time.** If job 2's argv were derived from the
live timeline only once job 1 finishes (which could be minutes later for a real
export), any edit made in between would silently change what job 2 actually renders.
Freezing the compiled argv on the job object at `enqueue()` time means "what you
queued is what you get," full stop.

## Sequential, not parallel — and why that's a real, stated scope call

Running two ffmpeg processes at once on one machine mostly slows both down rather
than finishing sooner (they compete for the same CPU/GPU encode resources) — so
sequential isn't just "the easy version," it's close to what a real bounded-worker
pool would converge to anyway for THIS workload, at a fraction of the complexity.
A genuine concurrency-limited scheduler (N workers, real backpressure, per-job
cancellation) is real, separately-scoped work — not built this pass, and not silently
implied by anything in the UI (the dialog never claims "parallel exports").

## What's genuinely NOT built (say so plainly, don't imply otherwise)

- **No cancel.** A running or queued job runs to completion; there is no "stop" button
  yet. A real gap for a long export a user wants to abort.
- **No reordering.** The queue is strict FIFO; there is no drag-to-reorder.
- **No persistence across an app restart.** The queue is in-memory (a zustand store),
  same as `useEditorTimelineStore`'s own undo history — closing the app loses any
  still-queued/running jobs' bookkeeping (though a `'running'` ffmpeg process itself,
  if truly backgrounded by the OS, might outlive the closed window; this was not
  specifically tested and should not be assumed).
- **No progress percentage per job** — `chroma_run_ffmpeg` itself blocks until ffmpeg
  exits and reports no incremental progress (same floor `chroma_motion_render`
  already holds); a job's UI state is exactly `queued`/`running`/`done`/`failed`, no
  finer granularity.

## Live verification recipe (D-142 harness)

`app/harness.html` + `app/src/harness-main.tsx` already mount `TimelinePane`
standalone in a real Chromium tab with a stubbed `window.__TAURI_INTERNALS__` — since
`EditorExportDialog` now lives in `TimelinePane`'s own toolbar, it comes along for
free. Three new stub handlers were needed:

```ts
chroma_timeline_clip_geometry: () => ({ compWidth: 1080, compHeight: 1920, naturalWidth: 1, naturalHeight: 1 }),
chroma_run_ffmpeg: () => ({ ok: true, stdout_tail: '', stderr_tail: '' }),
'plugin:dialog|save': () => '/tmp/harness-export.mp4',
```

`npm run dev` (in `app/`) + a Chrome DevTools MCP session against
`http://localhost:<port>/harness.html` is enough to click the real Export button,
watch the dialog compute real defaults, round-trip the save picker, and see a queued
job flip live to a green "Done" — the exact recipe used to verify this pass (see
D-198's own decision entry for what was actually observed).
