/**
 * @chroma/editor — the timeline switcher (D-046 pass 3; rebuilt as a tab
 * strip, D-058 item 3).
 *
 * A horizontal tab strip above the timeline pane: one tab per project
 * timeline (`chroma_timeline_list`, D-045), switching via
 * `chroma_timeline_set_active` on click, plus a `+` tab at the end that
 * creates a new empty timeline (`chroma_timeline_create`). Built on
 * `@chroma/ui`'s `Tabs`/`TabsList`/`TabsTrigger` (shadcn-on-Base-UI, D-042)
 * rather than the previous `Select` dropdown + separate "+ New" button —
 * the owner's ask was specifically a tab strip ("New ▾ | + New" was the
 * thing to replace), and this repo's standard is the canonical `@chroma/ui`
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
 */

import { useEffect, useState } from 'react';
import { Plus } from 'lucide-react';
import { Input, Tabs, TabsList, TabsTrigger } from '@chroma/ui';

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

  useEffect(() => {
    loadList();
  }, [loadList]);

  const active = timelines.find((t) => t.active);

  const submitCreate = async () => {
    const trimmed = name.trim();
    if (!trimmed) {
      setCreating(false);
      return;
    }
    await createTimeline(trimmed);
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
      <Tabs
        value={active?.id ?? ''}
        onValueChange={(value) => {
          const id = String(value);
          if (id === NEW_TIMELINE_TAB) {
            setCreating(true);
            return;
          }
          if (id && id !== active?.id) void setActiveTimeline(id);
        }}
      >
        <TabsList variant="line" className="h-8 w-full justify-start gap-0 rounded-none bg-transparent p-0">
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
              // from the others. Same one-word defect as `@chroma/ui`'s
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
              <Plus className="size-3.5" />
            </TabsTrigger>
          )}
        </TabsList>
      </Tabs>
    </div>
  );
}
