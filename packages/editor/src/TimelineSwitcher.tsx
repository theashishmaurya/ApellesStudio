/**
 * @chroma/editor — the timeline switcher (D-046 pass 3; rebuilt as a tab
 * strip, D-056 item 3).
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
    <div className="shrink-0 border-b border-border-color bg-surface px-1.5">
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
        <TabsList variant="line" className="h-8 w-full justify-start gap-0.5 rounded-none bg-transparent p-0">
          {timelines.map((t) => (
            <TabsTrigger
              key={t.id}
              value={t.id}
              className="h-8 shrink-0 rounded-t-md rounded-b-none border-b-2 border-transparent px-2.5 text-[11px] data-selected:border-accent"
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
              className="h-8 w-8 shrink-0 justify-center rounded-t-md rounded-b-none px-0 text-text-secondary hover:text-text-primary"
            >
              <Plus className="size-3.5" />
            </TabsTrigger>
          )}
        </TabsList>
      </Tabs>
    </div>
  );
}
