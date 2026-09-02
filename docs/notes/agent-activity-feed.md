# notes/agent-activity-feed.md — the agent activity feed + `request_human`

Round-3 item 1. Built 2026-09-02. See `docs/00-vision.md` ("whatever edit the
agent makes I can see and make changes — one shared state"), `docs/08-decisions.md`
**D-032**, D-020 (the control bridge this hooks into), and
`docs/notes/agent-visual-feedback.md` (`request_human` is called out there as a
first-class tool).

Two pieces, one store, minimal upstream footprint.

## A. Agent activity feed

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
recordActivity(entry)  markUndoneFrom(id)  clearActivity()
postHumanRequest(reason, roi)  clearHumanRequest()  setFeedOpen(b)
```

## GUI

- `app/src/components/chroma/AgentActivityDock.tsx` (new) — a fixed
  bottom-left dock, mounted once in `App.tsx` next to `useChromaControl()`.
  Contains the `request_human` banner (top) + the collapsible activity feed.
  Hidden entirely when there's no activity and no pending request. RapidRAW
  `Text` / `Button` + the `bg-surface` / `border-border-color` / `text-text-*`
  tokens.
- `app/src/components/chroma/AgentRoiHighlight.tsx` (new) — the canvas ROI
  rect, rendered inside `ImageCanvas.tsx`'s overlay layer.

## Upstream-file edits (divergence — doc 09)

- `App.tsx` — +1 import, +1 `<AgentActivityDock />` in the tree.
- `components/panel/editor/ImageCanvas.tsx` — +1 import, +~6 lines to render
  `<AgentRoiHighlight>` in the existing absolute overlay layer.

Everything else is new files or edits to `useChromaControl.ts` (itself a
Chroma-only file from D-020) + `mcp/server.py` + `mcp/README.md`.

## MCP

`mcp/server.py` gains `request_human(reason: str, roi: dict | None = None)` →
`POST /op request_human`. Scope-first docstring: it's for genuine uncertainty
and creative calls, not routine steps; the agent should keep working after
`get_state` shows the request cleared. Tool count 23 → 24.
