/**
 * @apelles/editor — the timeline switcher (D-046 pass 3; a tab strip from
 * D-058 item 3; timeline management, D-411 Phase 0; a toolbar menu, D-432 P5).
 *
 * **What it is.** The open timeline's name with a caret, centred in the
 * timeline toolbar beside the playhead timecode (`docs/notes/ui-redesign.md`
 * §4.9). Its menu lists every project timeline (`chroma_timeline_list`, D-045)
 * as a radio group — picking one switches to it (`chroma_timeline_set_active`)
 * — then New timeline…, Rename…, Duplicate, Size and Delete… for the open one.
 * Final Cut shows the open project's name in the same place with the same
 * kind of menu; before P5 this was a half-width tab strip above the toolbar
 * (`2026-09-09-edit` + `+`), which cost the timeline a 32 px row and elided
 * long names. The tab strip's double-click rename and per-tab right-click menu
 * became the menu's Rename… and the actions under it.
 *
 * **D-411 Phase 0 — rename, duplicate, size, delete.** Modelled on how the
 * reference NLEs manage sequences (`scratch/clipper-reference/
 * timeline-management.md`): Premiere duplicates a sequence as an independent
 * copy named "… copy"; Resolve's per-timeline settings let one timeline leave
 * "Use Project Settings" for its own resolution (1080×1920 for vertical). A
 * timeline with its own size shows it beside its name (`9:16`). Delete asks
 * first: it is a project-level action and not undoable. Every action is the
 * same store action `editor_*_timeline` runs (CLAUDE.md: human AND AI), and a
 * custom size lives in the Project Settings panel's "This timeline" section.
 *
 * B-080 — a switch awaits a real flush of the pending debounced save, so the
 * switcher has two states it would not otherwise need: `pending` (the trigger
 * is inert while the flush is in flight, so a second pick cannot start a second
 * switch behind the first) and `error` (the refusal, in words, beside the
 * control that refused, until the next attempt clears it).
 */

import { useEffect, useState } from 'react';
import { CaretDownIcon, CopyIcon, FrameCornersIcon, PencilSimpleIcon, PlusIcon, TrashIcon } from '@phosphor-icons/react';
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
  Input,
} from '@apelles/ui';

import { useEditorTimelineStore, type TimelineSummary } from './timelineStore';
import { TIMELINE_OUTPUT_PRESETS, type OutputSpec } from './timeline';

/** The Size menu's radio value for "no own size — follow the project". */
const PROJECT_SIZE = 'project';

/** A size as the menu's radio value: `1080x1920`. */
function sizeValue(output: OutputSpec | null | undefined): string {
  return output ? `${output.width}x${output.height}` : PROJECT_SIZE;
}

/** The short label a timeline shows for its own size: the preset's aspect
 *  (`9:16`), or `W×H` for a custom size. `null` for "uses the project's". */
export function outputBadge(output: OutputSpec | null | undefined): string | null {
  if (!output) return null;
  const preset = TIMELINE_OUTPUT_PRESETS.find((p) => p.width === output.width && p.height === output.height);
  return preset ? preset.aspect : `${output.width}×${output.height}`;
}

/** The size choices. */
const SIZE_CHOICES: readonly { value: string; label: string }[] = [
  { value: PROJECT_SIZE, label: 'Project size' },
  ...TIMELINE_OUTPUT_PRESETS.map((p) => ({ value: `${p.width}x${p.height}`, label: `${p.aspect} · ${p.label}` })),
];

function outputFromValue(value: string): OutputSpec | null {
  if (value === PROJECT_SIZE) return null;
  const preset = TIMELINE_OUTPUT_PRESETS.find((p) => `${p.width}x${p.height}` === value);
  return preset ? { width: preset.width, height: preset.height } : null;
}

function SizeBadge({ output }: { output: OutputSpec | null | undefined }) {
  const badge = outputBadge(output);
  if (!badge) return null;
  return (
    <span className="rounded-xs border border-border-color px-1 text-2xs leading-tight text-text-secondary">{badge}</span>
  );
}

/** What the inline name field is doing, if it is showing. */
type NameEdit = { kind: 'create' } | { kind: 'rename'; id: string };

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
  const [nameEdit, setNameEdit] = useState<NameEdit | null>(null);
  const [draft, setDraft] = useState('');
  // D-411 — the timeline the delete confirmation is asking about.
  const [deleteTarget, setDeleteTarget] = useState<TimelineSummary | null>(null);
  // B-080 — see this file's module doc.
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    loadList();
  }, [loadList]);

  // D-411 — the OPEN timeline reads its name and size from the store's own
  // document, not the backend summary: a rename or resize of the open timeline
  // is an op (undoable), which reaches the backend only on the next debounced
  // save — and an undo of it never touches the summary at all.
  const timelines: TimelineSummary[] = summaries.map((t) =>
    t.active && activeDoc && activeDoc.id === t.id
      ? { ...t, name: activeDoc.name, output: activeDoc.output ?? null }
      : t,
  );
  const active = timelines.find((t) => t.active);

  /** Run one switch/create/management action, holding the switcher inert for
   *  its duration and surfacing a refusal rather than swallowing it. */
  const runSwitch = async (action: () => Promise<{ ok: boolean; error?: string }>) => {
    if (pending) return;
    setPending(true);
    setError(null);
    // No `try`/`finally`: no store action rejects (each reports through
    // `{ok, error}`), and D-201's React Compiler coverage test rejects a
    // `try` without a `catch`, which would switch the compiler off here.
    const res = await action();
    setPending(false);
    if (!res.ok) setError(res.error ?? 'the timeline action failed');
  };

  const startEdit = (edit: NameEdit, initial: string) => {
    setDraft(initial);
    setNameEdit(edit);
  };

  const submitEdit = async () => {
    const edit = nameEdit;
    const trimmed = draft.trim();
    setNameEdit(null);
    setDraft('');
    if (!edit || !trimmed) return;
    if (edit.kind === 'create') {
      await runSwitch(() => createTimeline(trimmed));
      return;
    }
    const current = timelines.find((t) => t.id === edit.id);
    if (trimmed !== current?.name) await runSwitch(() => renameTimeline(edit.id, trimmed));
  };

  const confirmDelete = async () => {
    const target = deleteTarget;
    setDeleteTarget(null);
    if (target) await runSwitch(() => deleteTimeline(target.id));
  };

  if (timelines.length === 0 || !active) return null;

  return (
    <div data-chroma-timeline-switcher className="flex min-w-0 items-center gap-1">
      {nameEdit ? (
        <Input
          autoFocus
          aria-label={nameEdit.kind === 'create' ? 'New timeline name' : 'Timeline name'}
          placeholder={nameEdit.kind === 'create' ? 'New timeline name…' : undefined}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => void submitEdit()}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void submitEdit();
            if (e.key === 'Escape') {
              setNameEdit(null);
              setDraft('');
            }
          }}
          className="h-6 w-44 text-sm"
        />
      ) : (
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <Button
                variant="ghost"
                size="xs"
                disabled={pending}
                aria-busy={pending}
                aria-label="Timelines"
                title={
                  (active.name || 'Untitled timeline') +
                  (active.output ? ` — ${active.output.width}×${active.output.height}` : ' — project size') +
                  ' (switch, create, rename, resize or delete timelines)'
                }
                data-chroma-timeline-trigger={active.id}
                className="h-6 max-w-64 gap-1.5 px-2 text-sm font-medium text-text-primary"
              >
                <span className="truncate">{active.name || 'Untitled timeline'}</span>
                <SizeBadge output={active.output} />
                <CaretDownIcon className="size-3 text-text-secondary" />
              </Button>
            }
          />
          <DropdownMenuContent align="center" className="min-w-56" data-chroma-timeline-menu={active.id}>
            <DropdownMenuGroup>
              <DropdownMenuLabel>Timelines</DropdownMenuLabel>
              <DropdownMenuRadioGroup
                value={active.id}
                onValueChange={(value) => {
                  const id = String(value);
                  if (id && id !== active.id) void runSwitch(() => setActiveTimeline(id));
                }}
              >
                {timelines.map((t) => (
                  <DropdownMenuRadioItem key={t.id} value={t.id} data-chroma-timeline-item={t.id}>
                    <span className="min-w-0 flex-1 truncate">{t.name || 'Untitled timeline'}</span>
                    <SizeBadge output={t.output} />
                  </DropdownMenuRadioItem>
                ))}
              </DropdownMenuRadioGroup>
            </DropdownMenuGroup>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={() => startEdit({ kind: 'create' }, '')}>
              <PlusIcon /> New timeline…
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => startEdit({ kind: 'rename', id: active.id }, active.name)}>
              <PencilSimpleIcon /> Rename…
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => void runSwitch(() => duplicateTimeline(active.id))}>
              <CopyIcon /> Duplicate
            </DropdownMenuItem>
            <DropdownMenuSub>
              <DropdownMenuSubTrigger>
                <FrameCornersIcon /> Size
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent>
                <DropdownMenuRadioGroup
                  value={sizeValue(active.output)}
                  onValueChange={(v) => void runSwitch(() => setTimelineOutput(active.id, outputFromValue(String(v))))}
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
            <DropdownMenuItem
              variant="destructive"
              disabled={timelines.length <= 1}
              onClick={() => setDeleteTarget(active)}
            >
              <TrashIcon /> Delete…
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      )}
      {error && (
        <span role="alert" title={error} className="max-w-48 truncate text-2xs text-destructive">
          {error}
        </span>
      )}

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
