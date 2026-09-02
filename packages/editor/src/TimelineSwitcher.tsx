/**
 * @chroma/editor — the timeline switcher (D-046 pass 3).
 *
 * A small strip above the timeline pane: a dropdown of the project's
 * timelines (`chroma_timeline_list`, D-045) with the active one checked,
 * switching via `chroma_timeline_set_active`, plus a "+ New" inline form that
 * creates an empty named timeline (`chroma_timeline_create`) and switches to
 * it. Deliberately not elaborate — no rename/delete UI yet (not asked for
 * this pass; `chroma_timeline_*` has no rename/delete commands to back it).
 */

import { useEffect, useState } from 'react';
import { Plus, Check } from 'lucide-react';
import {
  Button,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@chroma/ui';

import { useEditorTimelineStore } from './timelineStore';

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
    <div className="shrink-0 flex items-center gap-2 px-3 py-1 border-b border-border-color bg-surface">
      <Select
        value={active?.id ?? ''}
        onValueChange={(id) => {
          if (id && id !== active?.id) void setActiveTimeline(id);
        }}
      >
        <SelectTrigger className="h-6 text-[11px] w-auto min-w-[10rem]" aria-label="Active timeline">
          <SelectValue placeholder="Timeline">
            {(id: string) => timelines.find((t) => t.id === id)?.name || 'Untitled timeline'}
          </SelectValue>
        </SelectTrigger>
        <SelectContent>
          {timelines.map((t) => (
            <SelectItem key={t.id} value={t.id} className="text-[11px]">
              <span className="flex items-center gap-1.5">
                {t.active && <Check className="size-3 text-accent" />}
                {t.name || 'Untitled timeline'}
              </span>
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

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
          className="h-6 text-[11px] w-40"
        />
      ) : (
        <Button
          variant="ghost"
          size="xs"
          onClick={() => setCreating(true)}
          className="h-6 gap-1 text-text-secondary hover:text-text-primary"
        >
          <Plus className="size-3" /> New
        </Button>
      )}
    </div>
  );
}
