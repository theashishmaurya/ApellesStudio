/**
 * @apelles/editor — the timeline switcher (D-046 pass 3; rebuilt as a tab
 * strip, D-058 item 3).
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
 * Deliberately not elaborate — no rename/delete UI yet (not asked for this
 * pass; `chroma_timeline_*` has no rename/delete commands to back it).
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
import { PlusIcon } from '@phosphor-icons/react';
import { Input, Tabs, TabsList, TabsTrigger } from '@apelles/ui';

import { useEditorTimelineStore } from './timelineStore';

/** Not a real timeline id — `onValueChange`'s signal that the `+` tab was
 *  clicked, intercepted before it ever reaches `setActiveTimeline`. */
const NEW_TIMELINE_TAB = '__new_timeline__';

export function TimelineSwitcher() {
  const timelines = useEditorTimelineStore((s) => s.timelines);
  const loadList = useEditorTimelineStore((s) => s.loadList);
  const createTimeline = useEditorTimelineStore((s) => s.createTimeline);
  const setActiveTimeline = useEditorTimelineStore((s) => s.setActiveTimeline);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  // B-080 — see this file's module doc: a switch now awaits a real flush, so
  // it has an in-flight state and a way to fail.
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    loadList();
  }, [loadList]);

  const active = timelines.find((t) => t.active);

  /** Run one switch/create, holding the strip inert for its duration and
   *  surfacing a refusal rather than swallowing it. */
  const runSwitch = async (action: () => Promise<{ ok: boolean; error?: string }>) => {
    if (pending) return;
    setPending(true);
    setError(null);
    // No `try`/`finally` here deliberately, twice over: neither store action
    // can reject (both catch internally and report through `{ok, error}`), so
    // there is nothing to catch — and D-201's React Compiler coverage test
    // rejects this file outright for a `try` without a `catch`
    // ("BuildHIR::lowerStatement"), which would switch the compiler off for
    // the whole module.
    const res = await action();
    setPending(false);
    if (!res.ok) setError(res.error ?? 'the timeline switch failed');
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
      <Tabs
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
            'h-8 w-full justify-start gap-0 rounded-none bg-transparent p-0 ' +
            (pending ? 'pointer-events-none opacity-60' : '')
          }
        >
          {timelines.map((t) => (
            <TabsTrigger
              key={t.id}
              value={t.id}
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
              className="h-8 shrink-0 grow-0 basis-auto rounded-t-md rounded-b-none border-r border-border-color/60 border-b-2 border-b-transparent px-3 text-[11px] last:border-r-0 data-active:border-b-accent"
            >
              {t.name || 'Untitled timeline'}
            </TabsTrigger>
          ))}
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
    </div>
  );
}
