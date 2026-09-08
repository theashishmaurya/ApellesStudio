/**
 * @chroma/editor — the registry of Edit-tab popovers/dialogs a debug op can
 * open or close by name (D-251, `docs/notes/debug-tooling.md` piece 2).
 *
 * **What it is.** The small, closed set of panel ids `useEditorTimelineStore`'s
 * `openPanels` map recognises, the parser that turns an untyped
 * `debug_set_popover_open` argument into one of them, and `usePanelOpen` — a
 * drop-in replacement for `const [open, setOpen] = useState(false)` that
 * reads/writes that map instead of local component state. The shape mirrors
 * `clipInspectorTabs.ts`'s `parseClipInspectorTab`: recognise or refuse by
 * name (D-216's rule), never coerce a typo into a silent no-op.
 *
 * **What it does NOT do.** It holds no state itself — that lives in
 * `timelineStore.ts`'s `openPanels` — and it renders nothing: each panel
 * component still owns its own `Popover`/`Dialog` markup and trigger, it just
 * gets its open flag from `usePanelOpen(id)` instead of `useState`.
 *
 * **Why one generic map instead of a bespoke boolean field per popover**
 * (the pattern D-219/D-246 used for `inspectorOpen`/`inspectorTab`, which
 * only ever needed to name two pieces of Edit-tab chrome). A repo sweep for
 * this feature turned up FOUR independent popovers/dialogs already gated
 * behind local `useState` before this one landed —
 * `CaptionPanel` (`open_`), `CanvasSettingsPopover` (`open`),
 * `EditorExportDialog` (`open`), and `EditLibraryRail`'s per-rail-button
 * popovers (fully uncontrolled, no state at all yet) — with a fifth,
 * `MarkerStrip`'s per-marker editor, keyed by *which marker* rather than a
 * plain boolean. A bespoke `xOpen`/`setXOpen` store field plus its own debug
 * op and its own `debug_get_ui_state` line, repeated per popover, is exactly
 * the copy-paste CLAUDE.md's "shared logic → extract, never copy-paste" rule
 * exists to stop — and every future popover would pay that same fixed cost
 * again. One map + one parser + one op scales to the next popover for the
 * price of one line here and one `useState` → `usePanelOpen` swap at the call
 * site, which is why this is the debug-tooling investment (see this repo's
 * CLAUDE.md's "human AND AI" rule — debug-only surfaces are exempt from
 * needing a GUI/MCP pair of their own, but the reachability problem itself
 * still deserves a real, reusable fix rather than a one-off).
 *
 * **Not migrated yet, deliberately** (real follow-on gaps, not silently
 * dropped): `EditLibraryRail`'s rail popovers are `<Popover>` with NO
 * `open`/`onOpenChange` at all — Base UI manages them internally because a
 * native HTML5 drag out of one must keep it open for the whole drag (see that
 * file's own comment), and lifting that to a controlled boolean risks
 * breaking the drag-open behaviour, which is out of scope for a debug-tooling
 * pass. `MarkerStrip`'s marker editor is keyed by `editingId: string | null`
 * (which marker, not just open/closed) — fits a *different* generic shape
 * (`Record<string, string | null>`) that would be its own small design, not
 * a one-line addition to this boolean map. Both are recorded here so the next
 * agent extending this doesn't have to rediscover them.
 */
import { useEditorTimelineStore } from './timelineStore';

/** Every popover/dialog this registry can open or close by name. Add a new
 *  panel here, plus one `useState(false)` → `usePanelOpen(id)` swap at its
 *  call site — no store field, no new debug op, no new arg parser needed. */
export const PANEL_IDS = ['caption-panel', 'canvas-settings', 'export-dialog'] as const;

export type PanelId = (typeof PANEL_IDS)[number];

/** Parse an untyped panel id (the `debug_set_popover_open` op's argument), or
 *  say why it is not one. Kept here rather than in `@chroma/debug`'s
 *  `uiState.ts` so the accepted set has exactly one definition — the same
 *  reason `parseClipInspectorTab` lives next to `CLIP_INSPECTOR_TABS`. */
export function parsePanelId(raw: unknown): PanelId | null {
  if (typeof raw !== 'string') return null;
  return (PANEL_IDS as readonly string[]).includes(raw) ? (raw as PanelId) : null;
}

/** A popover/dialog's open flag, lifted out of its own component's
 *  `useState` into the shared `openPanels` map. A panel id with no entry yet
 *  reads as closed (`false`), matching every migrated popover's own previous
 *  `useState(false)` default. */
export function usePanelOpen(id: PanelId): [boolean, (open: boolean) => void] {
  const open = useEditorTimelineStore((s) => s.openPanels[id] ?? false);
  const setPanelOpen = useEditorTimelineStore((s) => s.setPanelOpen);
  return [open, (next: boolean) => setPanelOpen(id, next)];
}
