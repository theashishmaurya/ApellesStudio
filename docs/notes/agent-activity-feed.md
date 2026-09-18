# notes/agent-activity-feed.md — the agent activity feed + `request_human`

Round-3 item 1. Built 2026-09-02. See `docs/00-vision.md` ("whatever edit the
agent makes I can see and make changes — one shared state"), `docs/08-decisions.md`
**D-032**, D-020 (the control bridge this hooks into), and
`docs/notes/agent-visual-feedback.md` (`request_human` is called out there as a
first-class tool).

Two pieces, one store, minimal upstream footprint.

> **Updated 2026-09-10 by D-298 — this is a THREE-tab feed now, and it is
> shell-level.** Everything below still describes the Colorist half exactly, and
> that half is unchanged. What changed: the dock is no longer mounted in
> `App.tsx` (it is injected into `@apelles/shell`'s `overlay` slot by
> `Root.tsx`, so it is on screen whatever tab is active), and the Edit and
> Motion tabs feed it too. They do so through a *different* mechanism, and
> deliberately so — see "C. The other two tabs" at the end.

## A. Agent activity feed (Colorist)

A running, newest-first list of every grade change the agent made through the
MCP/control bridge. Per entry: a human-readable summary, a timestamp, an
expandable per-field **diff** of the grade before vs after the op, and an
**undo** button.

### Where it's recorded — the one chokepoint

`app/src/hooks/useChromaControl.ts`, the single `listen('chroma://request')`
handler (D-020). Every MCP op already passes through here. For a **mutating** op
(not in `READ_ONLY`, not `seek` / `open` / `request_human`):

1. **before** `fn(args)`: snapshot `{ historyIndex, adjustments }` from
   `useEditorStore`.
2. run the op + `settleAndCapture()` as before.
3. if it succeeded (`!result.error`): `debouncedSetHistory.flush()` — force the
   pending debounced `pushHistory` to fire **now**, so this op lands as exactly
   one history entry (see "one entry per op" below).
4. snapshot `adjustments` **after**; `diffAdjustments(before, after)`.
5. if the diff is non-empty, `useAgentStore.recordActivity({...})` with the
   summary, both snapshots, the diff, `historyIndexBefore`, and the video frame
   at the time (context only).

An empty diff ⇒ no entry (a redundant `set_primary`, etc. — silent, like it
should be).

### Data model — `AgentActivityEntry`

```ts
{
  id: string,                    // uuid
  op: string,                    // "set_primary", "add_subject_mask", …
  args: any,                     // the op args (for the summary + debugging)
  ts: number,                    // Date.now()
  summary: string,               // "primary: exposure +0.35, temp −8"
  frame: number | null,          // transport frame when the op ran (context)
  historyIndexBefore: number,    // useEditorStore.historyIndex before the op
  adjustmentsBefore: Adjustments,// full snapshot — undo fallback + diff base
  adjustmentsAfter: Adjustments, // full snapshot — diff target (history evicts)
  diff: FieldDiff[],             // [{ path, before, after }]
  undone: boolean,
}
```

Snapshots are the same shape/size RapidRAW's own 50-slot history stack already
holds, so this is not new memory pressure of a different order. The feed is
capped at **50** entries (FIFO), same as the history stack.

### The diff — `app/src/utils/agentActivity.ts` (pure, unit-testable)

`diffAdjustments(a, b)` — a recursive structural diff producing
`{ path, before, after }` rows:

- nested plain objects: recurse (`colorGrading.shadows.hue`).
- `masks` (and `aiPatches`): matched **by container `id`**, not index — a row
  per changed field (`mask "Depth Haze".dehaze`), plus `mask "…" added` /
  `removed` for whole containers, and the same one level down for sub-masks.
- **heavy fields** (`maskDataBase64`, `mask_data_base64`) are never dumped —
  the row is `{ before: '<matte>'|null, after: '<matte>'|null }` keyed on
  presence/length only. `chromaTrackDir` diffs as its string (short).
- scalars: straight `{ before, after }`.

`summarizeActivity(op, args, result, diff)` — a small per-op formatter map
(`set_primary` → `primary: <knob list>` off `result.applied`; `match_reference`
→ `match to reference: N iters, gap X→Y`; `add_subject_mask` → `added subject
mask (additive)`; …). Fallback for an unmapped op: a knob list built from the
diff rows, else `"N fields changed"`. Formatters are cosmetic — the diff is the
source of truth.

### Undo — jump-to-here on the history stack

Undo of entry *E* = **revert the grade to the state before *E* ran, and drop
every feed entry newer than *E*** (they were built on *E*'s result — keeping
them would be a lie). This is the history slider's "jump to here" semantics, not
a branching timeline.

```
target = E.historyIndexBefore
if history[target] deep-equals E.adjustmentsBefore:
    goToHistoryIndex(target)                    // true history jump; Cmd-Z/redo still coherent
else:
    setEditor({ adjustments: E.adjustmentsBefore }); pushHistory(E.adjustmentsBefore)   // snapshot restore
bumpFrameNonce()                                 // re-render (video)
useAgentStore.markUndoneFrom(E.id)               // E + all newer entries → undone:true
```

**Documented limitations (v1, by design — D-027/D-030 "cheapest that works"):**

- **Middle undo is destructive to newer feed entries.** Undo entry 3 of 5 and
  entries 4–5 are marked `undone` and their "Undo" buttons disable. The grade
  jumps back past all of them. No per-op selective revert, no re-apply.
- **History-cap fallback.** RapidRAW's stack holds 50 states and `shift()`s the
  oldest. If the agent made >50 mutations, the pre-op state for the oldest feed
  entries has scrolled off `history[]`. Detected by the deep-equals check; we
  then restore `adjustmentsBefore` **as a new forward edit** (a new history
  entry) rather than a jump. The grade is still correct; only the "it's a clean
  history rewind" property is lost for those old entries.
- The feed is **session-only** — not persisted, not in `grade.json`. It's a
  working record of what the agent just did, not an audit log.

**D-051 update (2026-09-03):** the pseudocode above (fast-path history jump,
snapshot-restore fallback) now lives as a standalone, shared function —
`restoreEditorHistorySnapshot(targetIndex, snapshot)` in
`app/src/utils/editorHistorySnapshot.ts` — extracted out of
`AgentActivityDock.tsx`'s `undoEntry` so the new shell-level global undo/redo
(`@apelles/history`, bridged in via `useColoristHistoryBridge.ts`) can reuse
the exact same restore logic instead of a second implementation drifting
from this one. `undoEntry` now just calls it + `markUndoneFrom`. The feed
itself, its jump-to-here semantics, and the limitations below are unchanged —
see D-051 in `08-decisions.md` for why the shared undo stack does *not* also
write into this feed (a deliberate, documented scope line: this feed is an
agent-attribution log, the shared stack is generic cross-tab/cross-actor
undo).

### One entry per op (not per internal step)

Recording happens once per `chroma://request`. `match_reference` runs ~5
internal `setAdjustments` iterations over ~16 s → the `debouncedSetHistory`
(500 ms trailing) coalesces them and the `flush()` in step 3 lands the final
state → **one** history entry and **one** feed entry, summarised
`gap 78→10`. Same for `apply_haze` (`handleAddDepthHaze` = container +
sub-mask + grade in one `setAdjustments`).

Verified that every bridge op already routes through
`useEditorActions().setAdjustments` (the `debouncedSetHistory` singleton) —
directly, or via `useAiMasking` which imports the same. No bridge op mutates
`adjustments` without pushing history, so the feed's undo and the user's Cmd-Z
both work after an agent edit. (This was a check the task called out; it passed
— no fix needed.)

### `seek` / `open` — not logged

Pure navigation. `seek` moves the playhead, not the grade; logging it would spam
the feed on every scrub the agent does while measuring. `open` swaps the whole
clip. Neither produces a feed entry. (A grade *change* while parked on a frame
still logs, with that frame in `entry.frame`.)

## B. `request_human(reason, roi?)`

An MCP tool + bridge op the agent calls when it's unsure or done, to hand back
to the user. **Non-blocking** — it posts a request and returns an ack
immediately (it does *not* hold the MCP call open waiting for the human).

### Round-trip

```
agent → request_human(reason, roi?)
  → OPS.request_human validates, useAgentStore.postHumanRequest(reason, roi)
  → returns { posted: true, reason, roi } immediately
GUI: <RequestHumanBanner> shows the reason + a "Resume agent" button;
     if roi given, <AgentRoiHighlight> draws the rect on the canvas.
user clicks "Resume agent" → useAgentStore.clearHumanRequest()  (sets cleared:true)
agent → get_state  → { …, pendingHumanRequest: { reason, roi, cleared, ts } | null }
  cleared:true (or null) ⇒ the human is done, continue.
```

`roi` is normalised `{ x, y, w, h }` in 0..1 (top-left origin), clamped on
receipt. Rejected with a clear error if malformed. The canvas highlight reuses
the mask-overlay coordinate space in `ImageCanvas.tsx`
(`imageRenderSize.offsetX/Y/width/height`) — a 2 px amber rect + an outside dim,
no pixel math of its own.

`get_state` always carries `pendingHumanRequest` (null when none) so the agent
can poll. The request survives until the user clears it or the agent posts a new
one (last-write-wins, single slot).

## Store — `app/src/store/useAgentStore.ts` (new)

A small dedicated Zustand store (kept out of `useChromaStore` / `useEditorStore`
so the fork diff stays localised — same rationale as `useChromaStore`, D-003):

```ts
activity: AgentActivityEntry[]            // newest first, cap 50
pendingHumanRequest: HumanRequest | null  // { reason, roi, ts, cleared }
feedOpen: boolean                         // dock expand/collapse (per session)
dockDismissed: boolean                    // B-159 — activity-list card hidden via "Hide" (X)
dismissedAtRowKey: string | null          // B-159 — newest row's key when dismissed
recordActivity(entry)  markUndoneFrom(id)  clearActivity()
postHumanRequest(reason, roi)  clearHumanRequest()  setFeedOpen(b)  dismissDock(topRowKey)
```

`dockDismissed` is distinct from `feedOpen`: the caret toggle sets `feedOpen`
and only collapses the row list, leaving the header (title, count, clear,
hide) on screen; the "Hide" (X) button sets `dockDismissed` and hides the
whole card. **B-159** was exactly this: the X button called `setFeedOpen`
too, so it silently duplicated the caret and never visibly did anything with
rows present. A dismissal is not permanent — `AgentActivityDock` derives
`isDismissed = dockDismissed && rows[0]?.key === dismissedAtRowKey`, so it
re-shows itself the instant the newest row (Colorist or Edit/Motion) changes,
i.e. on the next genuinely new activity item, from either source.

## GUI

- `app/src/components/chroma/AgentActivityDock.tsx` (new) — a fixed
  bottom-left dock. Mounted in `App.tsx` until **D-298**; it is now injected
  into `@apelles/shell`'s `overlay` slot by `Root.tsx`, so it is on screen
  whatever tab is active.
  Contains the `request_human` banner (top) + the collapsible activity feed.
  Hidden entirely when there's no activity and no pending request. RapidRAW
  `Text` / `Button` + the `bg-surface` / `border-border-color` / `text-text-*`
  tokens.
- `app/src/components/chroma/AgentRoiHighlight.tsx` (new) — the canvas ROI
  rect, rendered inside `ImageCanvas.tsx`'s overlay layer.

## Upstream-file edits (divergence — doc 09)

- `App.tsx` — was +1 import, +1 `<AgentActivityDock />` in the tree; **D-298
  removed both** (the dock is injected from `Root.tsx` into the shell now, so
  this upstream file is back to zero footprint for this feature).
- `components/panel/editor/ImageCanvas.tsx` — +1 import, +~6 lines to render
  `<AgentRoiHighlight>` in the existing absolute overlay layer.

Everything else is new files or edits to `useChromaControl.ts` (itself a
Apelles-only file from D-020) + `mcp/server.py` + `mcp/README.md`.

## MCP

`mcp/server.py` gains `request_human(reason: str, roi: dict | None = None)` →
`POST /op request_human`. Scope-first docstring: it's for genuine uncertainty
and creative calls, not routine steps; the agent should keep working after
`get_state` shows the request cleared. Tool count 23 → 24.


---

## C. The other two tabs (D-298)

The Edit and Motion tabs record agent work through `@apelles/history`, not
through `useAgentStore`, and the dock merges the two into one list.

**Why not the same store.** `useAgentStore` lives in `app/src`, which a
`packages/*` tab package must not import (D-039's one-way layer rule), and
every field of an entry above is Colorist-shaped: two full `Adjustments`
snapshots, a `diffAdjustments` field diff, and an undo that jumps the
Colorist's own history index. None of that has a meaning for "trim clip 3" or
"add a layer".

**What is used instead.** Every Edit and Motion op already pushes a
`@apelles/history` entry — `{ tab, label, undo, redo }` — because that is how
global undo works (D-051), and that package is already a dependency of both tab
packages and of `app`. The only missing fact was *who caused it*:

- `HistoryEntry.source: 'user' | 'agent'`, defaulting to `'user'`.
- `runAsAgent(fn)` — a re-entrant depth counter, unwound in a `finally`, that
  stamps every push inside its window.
- Each tab's MCP dispatcher (`useEditorControl.ts`, `useMotionControl.ts`)
  wraps its handler call in it. **One line per tab, not one per op**, so a new
  op is instrumented the day it is written.

**What the dock shows for them:** label, tab and time — and **no per-row
Undo**. The shared stack is LIFO: undoing an entry that is not on top would
apply a reversal out of order and leave the stack describing a state the app is
no longer in. Cmd/Ctrl+Z is the right control for those, and it is already
global. The Colorist rows keep their per-row undo because the Colorist's own
history supports a *jump* to an index, which is a different primitive.

**Deduplication.** D-051's Colorist→shared-history bridge pushes grade edits
onto the same stack, so the shared-stack side of the merge filters
`tab !== 'colorist'`; Colorist rows come from `useAgentStore`, where the diff
and the jump-undo live.

**Honest limit.** The depth counter is not async-context tracking. A push that
lands after an `await` while two MCP ops are interleaved could be attributed to
the wrong one. It is still attributed to *an agent*, and this is a feed label
rather than state, so the cost is one wrong row.
`packages/history/src/store.test.ts` pins the case that matters (a push after
an `await` inside a handler is still agent-scoped) and the one that would be
dangerous (a throwing handler must not leak the counter and make every later
user edit read as agent work).

**Live-verified, 2026-09-10.** This design was unit-tested but not confirmed
against the real running app. Confirmed live, incidentally: a `debug_screenshot`
taken while the **Edit** tab was frontmost showed the Agent Activity dock
displaying two **Colorist** MCP actions (`set_color_grade`, `set_primary`) that
had just been called via `mcp__chroma__set_color_grade`/`set_primary` while a
different tab was active. That is exactly the D-298 claim — one shell-level
feed, global across tabs, not scoped to whichever tab happens to be showing —
observed working, not just documented.
