// Chroma — the Sources / Library panel (D-046, roadmap "media pool + import +
// multiple timelines" pass 3).
//
// Docked in the shell (via `Shell`'s `sourcesPanel` prop, wired in
// `app/src/main.tsx`) so it's reachable from every tab, not nested inside one
// tab's own panel system. Lives in `app/` rather than `@chroma/shell` because
// it needs `useSessionStore` (`_hydrateOpenDto`, for "add to grading") and
// `@chroma/editor`'s drag-to-track contract — the shell package must not
// depend on either (D-039 layer direction: app → tabs → services → domain;
// shell stays generic, same reasoning `ProjectLauncher` being injected via a
// prop already established).
//
// Contents: an Import button (native multi-select picker, same `pickClips`
// dialog `ProjectLauncher`'s "New Project" flow uses), a client-side search
// filter, a collapsible bin tree derived from `MediaItem.folder` path strings
// (drag an item onto a folder to re-file it — `chroma_media_move`), and a
// thumbnail-less grid of the pool (a real thumbnail strip is a later pass —
// see the D-046 decision) — drag a grid item onto the Edit tab's timeline to
// add it as a clip (`@chroma/editor`'s `CHROMA_MEDIA_DRAG_MIME` contract,
// plain HTML5 drag/drop, not a shared DnD context — see `TimelinePane`'s
// doc). A "+" on each item is the explicit "add to grading" action
// (`chroma_project_add_shot`), distinct from import: importing is pool-only
// by design, grading is opt-in per item.
import { useEffect, useMemo, useState, type DragEvent } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { toast } from 'react-toastify';
import { ChevronRight, Film, Folder, FolderOpen, Plus, Search, WifiOff } from 'lucide-react';
import { Button, Input, cn } from '@chroma/ui';
import { useMediaPoolStore, type MediaItem } from '@chroma/bridge';
import { CHROMA_MEDIA_DRAG_MIME } from '@chroma/editor';

import { useSessionStore, type ProjectOpenDto } from '../../store/useSessionStore';
import { pickClips } from './ProjectLauncher';

// --- bin tree, derived client-side from the flat `folder` path strings -----

interface FolderNode {
  name: string;
  path: string;
  children: FolderNode[];
}

function buildFolderTree(items: MediaItem[]): FolderNode[] {
  const root: FolderNode[] = [];
  const byPath = new Map<string, FolderNode>();
  for (const it of items) {
    if (!it.folder) continue;
    let path = '';
    let siblings = root;
    for (const seg of it.folder.split('/').filter(Boolean)) {
      path = path ? `${path}/${seg}` : seg;
      let node = byPath.get(path);
      if (!node) {
        node = { name: seg, path, children: [] };
        byPath.set(path, node);
        siblings.push(node);
      }
      siblings = node.children;
    }
  }
  return root;
}

function isMediaDrag(e: DragEvent): boolean {
  return e.dataTransfer.types.includes(CHROMA_MEDIA_DRAG_MIME);
}

function FolderRow({
  node,
  depth,
  activeFolder,
  setActiveFolder,
  onDropMedia,
}: {
  node: FolderNode;
  depth: number;
  activeFolder: string | null;
  setActiveFolder: (p: string | null) => void;
  onDropMedia: (mediaId: string, folder: string) => void;
}) {
  const [open, setOpen] = useState(true);
  const [dragOver, setDragOver] = useState(false);
  const hasChildren = node.children.length > 0;

  return (
    <div>
      <div
        role="button"
        tabIndex={0}
        onClick={() => setActiveFolder(activeFolder === node.path ? null : node.path)}
        onDragOver={(e) => {
          if (!isMediaDrag(e)) return;
          e.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => {
          setDragOver(false);
          const raw = e.dataTransfer.getData(CHROMA_MEDIA_DRAG_MIME);
          if (!raw) return;
          e.preventDefault();
          try {
            const media = JSON.parse(raw) as { id: string };
            onDropMedia(media.id, node.path);
          } catch {
            /* ignore malformed payload */
          }
        }}
        className={cn(
          'flex items-center gap-1 py-1 pr-2 rounded text-[11px] cursor-pointer select-none',
          activeFolder === node.path
            ? 'bg-accent/15 text-text-primary'
            : 'text-text-secondary hover:text-text-primary hover:bg-surface-hover',
          dragOver && 'ring-1 ring-accent bg-accent/10',
        )}
        style={{ paddingLeft: 6 + depth * 14 }}
      >
        <span
          onClick={(e) => {
            if (!hasChildren) return;
            e.stopPropagation();
            setOpen((o) => !o);
          }}
          className={cn('shrink-0', !hasChildren && 'opacity-0')}
        >
          <ChevronRight className={cn('size-3 transition-transform', open && 'rotate-90')} />
        </span>
        {activeFolder === node.path ? (
          <FolderOpen className="size-3 shrink-0" />
        ) : (
          <Folder className="size-3 shrink-0" />
        )}
        <span className="truncate">{node.name}</span>
      </div>
      {open && hasChildren && (
        <div>
          {node.children.map((c) => (
            <FolderRow
              key={c.path}
              node={c}
              depth={depth + 1}
              activeFolder={activeFolder}
              setActiveFolder={setActiveFolder}
              onDropMedia={onDropMedia}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// --- the panel ---------------------------------------------------------------

export function SourcesPanel() {
  const projectOpen = useSessionStore((s) => !!s.projectPath || !!s.projectName);
  const items = useMediaPoolStore((s) => s.items);
  const loading = useMediaPoolStore((s) => s.loading);
  const refresh = useMediaPoolStore((s) => s.refresh);
  const importPaths = useMediaPoolStore((s) => s.importPaths);
  const moveToFolder = useMediaPoolStore((s) => s.moveToFolder);

  const [search, setSearch] = useState('');
  const [activeFolder, setActiveFolder] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  const [addingId, setAddingId] = useState<string | null>(null);

  useEffect(() => {
    if (projectOpen) void refresh();
  }, [projectOpen, refresh]);

  const tree = useMemo(() => buildFolderTree(items), [items]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return items.filter((it) => {
      if (activeFolder) {
        const f = it.folder ?? '';
        if (f !== activeFolder && !f.startsWith(`${activeFolder}/`)) return false;
      }
      if (q && !it.name.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [items, activeFolder, search]);

  const doImport = async () => {
    const paths = await pickClips();
    if (!paths.length) return;
    setImporting(true);
    const res = await importPaths(paths, activeFolder ?? undefined);
    setImporting(false);
    if (!res.ok) toast.error(`Import failed: ${res.error}`);
    else if (res.added && res.added.length < paths.length) {
      toast.info(`${paths.length - res.added.length} clip(s) were already in the pool`);
    }
  };

  const doMove = async (id: string, folder: string) => {
    const res = await moveToFolder(id, folder);
    if (!res.ok) toast.error(`Move failed: ${res.error}`);
  };

  const addToGrading = async (id: string) => {
    setAddingId(id);
    try {
      // `chroma_project_add_shot` returns the exact same `ProjectOpenDto`
      // shape `chroma_project_open`/`_new`/`_relink` do, which
      // `_hydrateOpenDto` already knows how to consume.
      const dto = await invoke<ProjectOpenDto>('chroma_project_add_shot', { mediaId: id });
      await useSessionStore.getState()._hydrateOpenDto(dto);
      toast.success('Added to grading');
    } catch (e) {
      toast.error(`Couldn't add to grading: ${String(e)}`);
    } finally {
      setAddingId(null);
      void refresh();
    }
  };

  if (!projectOpen) return null;

  return (
    <div className="h-full w-full flex flex-col bg-surface text-text-primary">
      <div className="shrink-0 flex items-center gap-1.5 px-2.5 py-2 border-b border-border-color">
        <span className="text-[11px] font-semibold tracking-wide text-text-secondary flex-1">
          SOURCES
        </span>
        <Button variant="ghost" size="xs" onClick={doImport} disabled={importing} className="h-6 gap-1">
          <Plus className="size-3" /> Import
        </Button>
      </div>

      <div className="shrink-0 px-2.5 py-1.5 border-b border-border-color">
        <div className="relative">
          <Search className="size-3 absolute left-2 top-1/2 -translate-y-1/2 text-text-secondary/60" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search media…"
            className="h-6 pl-6 text-[11px]"
          />
        </div>
      </div>

      {tree.length > 0 && (
        <div className="shrink-0 max-h-32 overflow-y-auto px-1 py-1 border-b border-border-color">
          <div
            role="button"
            tabIndex={0}
            onClick={() => setActiveFolder(null)}
            className={cn(
              'flex items-center gap-1 py-1 pl-1.5 pr-2 rounded text-[11px] cursor-pointer select-none',
              activeFolder === null
                ? 'bg-accent/15 text-text-primary'
                : 'text-text-secondary hover:text-text-primary hover:bg-surface-hover',
            )}
          >
            <Film className="size-3" /> All media
          </div>
          {tree.map((n) => (
            <FolderRow
              key={n.path}
              node={n}
              depth={0}
              activeFolder={activeFolder}
              setActiveFolder={setActiveFolder}
              onDropMedia={doMove}
            />
          ))}
        </div>
      )}

      <div className="flex-1 min-h-0 overflow-y-auto p-2">
        {loading && items.length === 0 ? (
          <p className="text-[11px] text-text-secondary p-2">Loading…</p>
        ) : filtered.length === 0 ? (
          <p className="text-[11px] text-text-secondary p-2">
            {items.length === 0
              ? 'No media yet — Import to add clips to this project (referenced in place, never copied).'
              : 'No media matches.'}
          </p>
        ) : (
          <div className="grid grid-cols-2 gap-2">
            {filtered.map((it) => (
              <div
                key={it.id}
                draggable
                onDragStart={(e) => {
                  e.dataTransfer.effectAllowed = 'copy';
                  e.dataTransfer.setData(
                    CHROMA_MEDIA_DRAG_MIME,
                    JSON.stringify({
                      id: it.id,
                      sourcePath: it.sourcePath,
                      name: it.name,
                      frameCount: it.video?.frameCount ?? null,
                    }),
                  );
                }}
                title={it.sourcePath}
                className="group relative flex flex-col gap-1 rounded-md border border-border-color bg-bg-primary p-1.5 cursor-grab active:cursor-grabbing hover:border-accent/60"
              >
                <div className="aspect-video w-full rounded bg-black/30 flex items-center justify-center relative overflow-hidden">
                  <Film className="size-4 text-text-secondary/50" />
                  {it.offline && (
                    <div className="absolute top-1 right-1 text-amber-400" title="Media offline">
                      <WifiOff className="size-3" />
                    </div>
                  )}
                </div>
                <span className="text-[10px] truncate text-text-secondary group-hover:text-text-primary">
                  {it.name}
                </span>
                <button
                  onClick={() => addToGrading(it.id)}
                  disabled={addingId === it.id || it.offline}
                  title="Add to grading"
                  aria-label={`Add ${it.name} to grading`}
                  className="absolute top-1 right-1 size-5 rounded-full bg-bg-primary/90 border border-border-color flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity disabled:opacity-40 hover:border-accent"
                >
                  <Plus className="size-3" />
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
