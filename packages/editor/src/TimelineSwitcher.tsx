/**
 * @apelles/editor — the timeline switcher (D-046 pass 3; rebuilt as a tab
 * strip, D-058 item 3; timeline management, D-411 Phase 0).
 *
 * A horizontal tab strip above the timeline pane: one tab per project
 * timeline (`chroma_timeline_list`, D-045), switching via
 * `chroma_timeline_set_active` on click, plus a `+` tab at the end that
 * creates a new empty timeline (`chroma_timeline_create`). Built on
 * `@apelles/ui`'s `Tabs`/`TabsList`/`TabsTrigger` (shadcn-on-Base-UI, D-042)
 * rather than the previous `Select` dropdown + separate "+ New" button —
 * the owner's ask was specifically a tab strip ("New ▾ | + New" was the
 * thing to replace), and this repo's standard is the canonical `@apelles/ui`
 * component for a job like this, not hand-rolled tab styling.
 *
 * The `+` tab is a `TabsTrigger` like any other so it gets the same
 * keyboard/hover/focus treatment for free, but clicking it must NOT select
 * it as the active tab (there's nothing to show there) — `Tabs` here is
 * fully controlled (`value` always the real active timeline's id), so
 * `onValueChange` intercepts the sentinel value and opens the inline "new
 * timeline" name field instead of ever writing it into `value`.
 *
 * **D-411 Phase 0 — rename, duplicate, size, delete.** Modelled on how the
 * reference NLEs manage sequences (`scratch/clipper-reference/
 * timeline-management.md`): Premiere duplicates a sequence from its
 * right-click menu as an independent copy named "… copy"; Resolve's per-
 * timeline "Timeline Settings" lets one timeline leave "Use Project Settings"
 * for its own resolution (1080×1920 for vertical) while the rest follow the
 * project. So each tab has a right-click menu — Rename, Duplicate, Size
 * (Project size or a delivery preset), Delete — and the same menu sits on a
 * `⋯` button after the tabs for the open timeline, because a right-click menu
 * alone is invisible to anyone who does not think to try it. Double-clicking a
 * tab renames it in place, the tab-strip convention. A timeline with its own
 * size shows it on its tab (`9:16`), so a short is recognisable at a glance.
 * Delete asks first: it is a project-level action and not undoable. Every
 * action is the same store action `editor_*_timeline` runs (CLAUDE.md: human
 * AND AI), and a custom size lives in the Project Settings panel's "This
 * timeline" section rather than in a menu.
 *
 * B-080 — a switch is no longer instantaneous: `setActiveTimeline`/
 * `createTimeline` now flush the Edit tab's pending debounced save to disk
 * first and only then issue their own command, because `chroma_timeline_set`
 * writes onto whichever timeline is ACTIVE when it arrives (see
 * `timelineStore.ts`'s own B-080 note). That flush is one already-scheduled IPC
 * round trip in the normal case — far too fast for a spinner, which is why
 * there isn't one — but it CAN fail, and it can refuse the switch when it does.
 * The strip therefore has two states it did not need before: `pending` (the tab
 * strip is inert while the flush is in flight, so a second click cannot start a
 * second switch behind the first) and `error` (the refusal, in words, instead
 * of a click that visibly does nothing).
 */

import { useEffect, useState } from 'react';
import { CopyIcon, DotsThreeIcon, FrameCornersIcon, PencilSimpleIcon, PlusIcon, TrashIcon } from '@phosphor-icons/react';
import {
  Button,
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuRadioGroup,
  ContextMenuRadioItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
  Input,
  Tabs,
  TabsList,
  TabsTrigger,
} from '@apelles/ui';

import { useEditorTimelineStore, type TimelineSummary } from './timelineStore';
import { TIMELINE_OUTPUT_PRESETS, type OutputSpec } from './timeline';

/** Not a real timeline id — `onValueChange`'s signal that the `+` tab was
 *  clicked, intercepted before it ever reaches `setActiveTimeline`. */
const NEW_TIMELINE_TAB = '__new_timeline__';

/** The Size menu's radio value for "no own size — follow the project". */
const PROJECT_SIZE = 'project';

/** A size as the menus' radio value: `1080x1920`. */
function sizeValue(output: OutputSpec | null | undefined): string {
  return output ? `${output.width}x${output.height}` : PROJECT_SIZE;
}

/** The short label a tab shows for its own size: the preset's aspect
 *  (`9:16`), or `W×H` for a custom size. `null` for "uses the project's". */
export function outputBadge(output: OutputSpec | null | undefined): string | null {
  if (!output) return null;
  const preset = TIMELINE_OUTPUT_PRESETS.find((p) => p.width === output.width && p.height === output.height);
  return preset ? preset.aspect : `${output.width}×${output.height}`;
}

/** The size choices, shared by both menus. */
const SIZE_CHOICES: readonly { value: string; label: string }[] = [
  { value: PROJECT_SIZE, label: 'Project size' },
  ...TIMELINE_OUTPUT_PRESETS.map((p) => ({ value: `${p.width}x${p.height}`, label: `${p.aspect} · ${p.label}` })),
];

function outputFromValue(value: string): OutputSpec | null {
  if (value === PROJECT_SIZE) return null;
  const preset = TIMELINE_OUTPUT_PRESETS.find((p) => `${p.width}x${p.height}` === value);
  return preset ? { width: preset.width, height: preset.height } : null;
}

interface MenuHandlers {
  onRename: () => void;
  onDuplicate: () => void;
  onSize: (output: OutputSpec | null) => void;
  onDelete: () => void;
  /** Delete is refused for a project's only timeline, so it is shown disabled. */
  canDelete: boolean;
}

/** One timeline's actions as a right-click menu on its tab. */
function TimelineContextMenuBody({ tab, h }: { tab: TimelineSummary; h: MenuHandlers }) {
  return (
    <ContextMenuContent data-chroma-timeline-menu={tab.id}>
      <ContextMenuItem onClick={h.onRename}>
        <PencilSimpleIcon /> Rename…
      </ContextMenuItem>
      <ContextMenuItem onClick={h.onDuplicate}>
        <CopyIcon /> Duplicate
      </ContextMenuItem>
      <ContextMenuSub>
        <ContextMenuSubTrigger>
          <FrameCornersIcon /> Size
        </ContextMenuSubTrigger>
        <ContextMenuSubContent>
          <ContextMenuRadioGroup
            value={sizeValue(tab.output)}
            onValueChange={(v) => h.onSize(outputFromValue(String(v)))}
          >
            {SIZE_CHOICES.map((c) => (
              <ContextMenuRadioItem key={c.value} value={c.value}>
                {c.label}
              </ContextMenuRadioItem>
            ))}
          </ContextMenuRadioGroup>
        </ContextMenuSubContent>
      </ContextMenuSub>
      <ContextMenuSeparator />
      <ContextMenuItem variant="destructive" disabled={!h.canDelete} onClick={h.onDelete}>
        <TrashIcon /> Delete…
      </ContextMenuItem>
    </ContextMenuContent>
  );
}

/** The same actions on the `⋯` button, for the open timeline. */
function TimelineDropdownMenuBody({ tab, h }: { tab: TimelineSummary; h: MenuHandlers }) {
  return (
    <DropdownMenuContent align="start" data-chroma-timeline-menu={tab.id}>
      <DropdownMenuItem onClick={h.onRename}>
        <PencilSimpleIcon /> Rename…
      </DropdownMenuItem>
      <DropdownMenuItem onClick={h.onDuplicate}>
        <CopyIcon /> Duplicate
      </DropdownMenuItem>
      <DropdownMenuSub>
        <DropdownMenuSubTrigger>
          <FrameCornersIcon /> Size
        </DropdownMenuSubTrigger>
        <DropdownMenuSubContent>
          <DropdownMenuRadioGroup
            value={sizeValue(tab.output)}
            onValueChange={(v) => h.onSize(outputFromValue(String(v)))}
          >
            {SIZE_CHOICES.map((c) => (
              <DropdownMenuRadioItem key={c.value} value={c.value}>
                {c.label}
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        </DropdownMenuSubContent>
      </DropdownMenuSub>
      <DropdownMenuSeparator />
      <DropdownMenuItem variant="destructive" disabled={!h.canDelete} onClick={h.onDelete}>
        <TrashIcon /> Delete…
      </DropdownMenuItem>
    </DropdownMenuContent>
  );
}

export function TimelineSwitcher() {
  const summaries = useEditorTimelineStore((s) => s.timelines);
  const activeDoc = useEditorTimelineStore((s) => s.timeline);
  const loadList = useEditorTimelineStore((s) => s.loadList);
  const createTimeline = useEditorTimelineStore((s) => s.createTimeline);
  const setActiveTimeline = useEditorTimelineStore((s) => s.setActiveTimeline);
  const renameTimeline = useEditorTimelineStore((s) => s.renameTimeline);
  const duplicateTimeline = useEditorTimelineStore((s) => s.duplicateTimeline);
  const deleteTimeline = useEditorTimelineStore((s) => s.deleteTimeline);
  const setTimelineOutput = useEditorTimelineStore((s) => s.setTimelineOutput);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  // D-411 — the tab being renamed in place, and its draft name.
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState('');
  // D-411 — the timeline the delete confirmation is asking about.
  const [deleteTarget, setDeleteTarget] = useState<TimelineSummary | null>(null);
  // B-080 — see this file's module doc: a switch now awaits a real flush, so
  // it has an in-flight state and a way to fail.
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    loadList();
  }, [loadList]);

  // D-411 — the OPEN timeline's tab reads its name and size from the store's
  // own document, not the backend summary: a rename or resize of the open
  // timeline is an op (undoable), which reaches the backend only on the next
  // debounced save — and an undo of it never touches the summary at all.
  const timelines: TimelineSummary[] = summaries.map((t) =>
    t.active && activeDoc && activeDoc.id === t.id
      ? { ...t, name: activeDoc.name, output: activeDoc.output ?? null }
      : t,
  );
  const active = timelines.find((t) => t.active);

  /** Run one switch/create/management action, holding the strip inert for its
   *  duration and surfacing a refusal rather than swallowing it. */
  const runSwitch = async (action: () => Promise<{ ok: boolean; error?: string }>) => {
    if (pending) return;
    setPending(true);
    setError(null);
    // No `try`/`finally` here deliberately, twice over: no store action
    // rejects (each catches internally and reports through `{ok, error}`), so
    // there is nothing to catch — and D-201's React Compiler coverage test
    // rejects this file outright for a `try` without a `catch`
    // ("BuildHIR::lowerStatement"), which would switch the compiler off for
    // the whole module.
    const res = await action();
    setPending(false);
    if (!res.ok) setError(res.error ?? 'the timeline action failed');
  };

  const submitCreate = async () => {
    const trimmed = name.trim();
    if (!trimmed) {
      setCreating(false);
      return;
    }
    await runSwitch(() => createTimeline(trimmed));
    setName('');
    setCreating(false);
  };

  const startRename = (t: TimelineSummary) => {
    setRenamingId(t.id);
    setRenameDraft(t.name);
  };

  const submitRename = async () => {
    const id = renamingId;
    const draft = renameDraft.trim();
    setRenamingId(null);
    const current = timelines.find((t) => t.id === id);
    if (!id || !draft || draft === current?.name) return;
    await runSwitch(() => renameTimeline(id, draft));
  };

  const confirmDelete = async () => {
    const target = deleteTarget;
    setDeleteTarget(null);
    if (target) await runSwitch(() => deleteTimeline(target.id));
  };

  const handlersFor = (t: TimelineSummary): MenuHandlers => ({
    onRename: () => startRename(t),
    onDuplicate: () => void runSwitch(() => duplicateTimeline(t.id)),
    onSize: (output) => void runSwitch(() => setTimelineOutput(t.id, output)),
    onDelete: () => setDeleteTarget(t),
    canDelete: timelines.length > 1,
  });

  if (timelines.length === 0) return null;

  return (
    // D-060: the strip previously spanned the full pane width regardless of
    // how many tabs it held (a single 2-tab project left most of the row
    // empty, dark space with no separation from the actual clip timeline
    // below it) — capped to half the pane's width per the owner's ask, with
    // a `min-w` floor so a long timeline name still has room before eliding.
    <div className="shrink-0 w-1/2 min-w-[220px] border-b border-border-color bg-surface px-1.5">
      {error && (
        // B-080 — the refusal, in words. Not a toast: the reason belongs next
        // to the control that refused, and it stays until the next attempt
        // (which clears it) rather than timing out while the user reads it.
        <div role="alert" className="px-1 py-0.5 text-[10px] leading-tight text-red-400">
          {error}
        </div>
      )}
      <div className="flex items-center">
        <Tabs
          className="min-w-0 flex-1"
          value={active?.id ?? ''}
          onValueChange={(value) => {
            const id = String(value);
            if (id === NEW_TIMELINE_TAB) {
              setCreating(true);
              return;
            }
            if (id && id !== active?.id) void runSwitch(() => setActiveTimeline(id));
          }}
        >
          <TabsList
            variant="line"
            // B-080 — inert (and visibly so) for the length of the flush + switch.
            // `runSwitch` already refuses a re-entrant call, so this is the
            // matching visual fact rather than the guard itself.
            aria-busy={pending}
            className={
              'h-8 w-full justify-start gap-0 overflow-x-auto rounded-none bg-transparent p-0 ' +
              (pending ? 'pointer-events-none opacity-60' : '')
            }
          >
            {timelines.map((t) => {
              const badge = outputBadge(t.output);
              if (renamingId === t.id) {
                return (
                  <Input
                    key={t.id}
                    autoFocus
                    aria-label="Timeline name"
                    value={renameDraft}
                    onChange={(e) => setRenameDraft(e.target.value)}
                    onBlur={() => void submitRename()}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') void submitRename();
                      if (e.key === 'Escape') setRenamingId(null);
                    }}
                    className="mx-1 h-6 w-36 shrink-0 text-[11px]"
                  />
                );
              }
              return (
                <ContextMenu key={t.id}>
                  <ContextMenuTrigger
                    render={
                      <TabsTrigger
                        value={t.id}
                        onDoubleClick={() => startRename(t)}
                        title={
                          (t.name || 'Untitled timeline') +
                          (t.output ? ` — ${t.output.width}×${t.output.height}` : ' — project size') +
                          ' (double-click to rename, right-click for more)'
                        }
                        // D-060: the shadcn base `TabsTrigger` ships `flex-1` (an
                        // equal-width segmented control) — this switcher's tabs are a
                        // real strip of independently-sized labels, not a segmented
                        // toggle, so `grow-0 basis-auto` overrides it (`shrink-0`
                        // alone, the pre-fix className, only cancels the *shrink*
                        // half of `flex-1` — the *grow* half was still splitting the
                        // row evenly, which is why every tab looked oversized and
                        // identical-width). A right hairline (`border-r`, dropped on
                        // the last tab) replaces the bare `gap-0.5` as the visual
                        // separator between tabs, since equal-width flex-1 was the
                        // only thing that had been keeping them apart before.
                        // B-124 — `data-active`, not `data-selected`: Base UI's own
                        // `Tabs.Tab` emits the former, so this accent underline had
                        // never once drawn and the active timeline was indistinguishable
                        // from the others. Same one-word defect as `@apelles/ui`'s
                        // `tabs.tsx` carried; fixed in the same pass so the two cannot
                        // drift back apart.
                        className="h-8 shrink-0 grow-0 basis-auto gap-1.5 rounded-t-md rounded-b-none border-r border-border-color/60 border-b-2 border-b-transparent px-3 text-[11px] last:border-r-0 data-active:border-b-accent"
                      />
                    }
                  >
                    <span className="max-w-40 truncate">{t.name || 'Untitled timeline'}</span>
                    {badge && (
                      <span className="rounded-sm border border-border-color px-1 text-[9px] leading-tight text-text-secondary">
                        {badge}
                      </span>
                    )}
                  </ContextMenuTrigger>
                  <TimelineContextMenuBody tab={t} h={handlersFor(t)} />
                </ContextMenu>
              );
            })}
            {creating ? (
              <Input
                autoFocus
                value={name}
                onChange={(e) => setName(e.target.value)}
                onBlur={submitCreate}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void submitCreate();
                  if (e.key === 'Escape') {
                    setName('');
                    setCreating(false);
                  }
                }}
                placeholder="New timeline name…"
                className="ml-1 h-6 w-36 shrink-0 text-[11px]"
              />
            ) : (
              <TabsTrigger
                value={NEW_TIMELINE_TAB}
                aria-label="New timeline"
                title="New timeline"
                className="h-8 w-8 shrink-0 grow-0 basis-auto justify-center rounded-t-md rounded-b-none px-0 text-text-secondary hover:text-text-primary"
              >
                <PlusIcon className="size-3.5" />
              </TabsTrigger>
            )}
          </TabsList>
        </Tabs>
        {active && (
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon-xs"
                  disabled={pending}
                  aria-label="Timeline actions"
                  title="Rename, duplicate, resize or delete this timeline"
                  className="shrink-0 text-text-secondary hover:text-text-primary"
                >
                  <DotsThreeIcon />
                </Button>
              }
            />
            <TimelineDropdownMenuBody tab={active} h={handlersFor(active)} />
          </DropdownMenu>
        )}
      </div>

      <Dialog open={deleteTarget !== null} onOpenChange={(open) => !open && setDeleteTarget(null)}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Delete timeline “{deleteTarget?.name || 'Untitled timeline'}”?</DialogTitle>
            <DialogDescription>
              Its clips, captions and markers go with it, and this cannot be undone. The media stays in the project.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setDeleteTarget(null)}>
              Cancel
            </Button>
            <Button variant="destructive" size="sm" onClick={() => void confirmDelete()}>
              Delete timeline
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
