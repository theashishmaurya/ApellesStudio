// Chroma — the Sources / Library panel (D-046 pass 3, D-056 pass 4).
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
// filter, a collapsible bin tree built from `useMediaPoolStore.folders`
// (D-056 — the union of explicitly-created folders and folders implied by
// `MediaItem.folder` strings, so a just-created empty folder shows up too;
// drag an item onto a folder to re-file it — `chroma_media_move`; right-click
// the tree or a folder row for "New Folder" — `chroma_media_create_folder`),
// and a grid of the pool with a real poster-frame thumbnail per item when one
// has been cached (D-056 — `MediaItem.thumb`; falls back to a placeholder
// icon otherwise) — drag a grid item onto the Edit tab's timeline to add it
// as a clip (`@chroma/editor`'s `CHROMA_MEDIA_DRAG_MIME` contract, plain
// HTML5 drag/drop, not a shared DnD context — see `TimelinePane`'s doc). A
// "+" on each item is the explicit "add to grading" action
// (`chroma_project_add_shot`), distinct from import: importing is pool-only
// by design, grading is opt-in per item.
import { useEffect, useMemo, useState, type DragEvent } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { toast } from 'react-toastify';
import { ChevronRight, Film, Folder, FolderOpen, FolderPlus, Plus, Search, WifiOff } from 'lucide-react';
import {
  Button,
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  cn,
} from '@chroma/ui';
import { useMediaPoolStore } from '@chroma/bridge';
import { CHROMA_MEDIA_DRAG_MIME } from '@chroma/editor';

import { useSessionStore, type ProjectOpenDto } from '../../store/useSessionStore';
import { pickClips } from './ProjectLauncher';

// --- bin tree, built from the known folder-path strings (D-056) ------------

interface FolderNode {
  name: string;
  path: string;
  children: FolderNode[];
}

function buildFolderTree(folders: string[]): FolderNode[] {
  const root: FolderNode[] = [];
  const byPath = new Map<string, FolderNode>();
  for (const folder of folders) {
    let path = '';
    let siblings = root;
    for (const seg of folder.split('/').filter(Boolean)) {
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

/** "Name this folder" prompt for both root-level and nested "New Folder"
 *  (D-056) — reached from the header button or either context menu. `@chroma/ui`'s
 *  `Dialog` (D-042 shadcn/Base UI), same controlled-`open` pattern
 *  `ExportDialog` already uses, rather than a bespoke modal. */
function NewFolderDialog({
  parentPath,
  onClose,
  onCreate,
}: {
  parentPath: string | null;
  onClose: () => void;
  onCreate: (fullPath: string) => void;
}) {
  const [name, setName] = useState('');
  const [creating, setCreating] = useState(false);

  const submit = async () => {
    const trimmed = name.trim();
    if (!trimmed) return;
    setCreating(true);
    const fullPath = parentPath ? `${parentPath}/${trimmed}` : trimmed;
    await onCreate(fullPath);
    setCreating(false);
  };

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-xs">
        <DialogHeader>
          <DialogTitle>New folder{parentPath ? ` in ${parentPath}` : ''}</DialogTitle>
        </DialogHeader>
        <Input
          autoFocus
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void submit();
            if (e.key === 'Escape') onClose();
          }}
          placeholder="Folder name"
          className="h-8 text-[12px]"
        />
        <DialogFooter>
          <Button variant="ghost" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button size="sm" onClick={() => void submit()} disabled={!name.trim() || creating}>
            Create
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
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
  onNewFolder,
}: {
  node: FolderNode;
  depth: number;
  activeFolder: string | null;
  setActiveFolder: (p: string | null) => void;
  onDropMedia: (mediaId: string, folder: string) => void;
  onNewFolder: (parentPath: string) => void;
}) {
  const [open, setOpen] = useState(true);
  const [dragOver, setDragOver] = useState(false);
  const hasChildren = node.children.length > 0;

  return (
    <div>
      <ContextMenu>
        <ContextMenuTrigger>
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
        </ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuItem onClick={() => onNewFolder(node.path)}>
            <FolderPlus className="size-3.5" /> New folder
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
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
              onNewFolder={onNewFolder}
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
  const folders = useMediaPoolStore((s) => s.folders);
  const loading = useMediaPoolStore((s) => s.loading);
  const refresh = useMediaPoolStore((s) => s.refresh);
  const importPaths = useMediaPoolStore((s) => s.importPaths);
  const moveToFolder = useMediaPoolStore((s) => s.moveToFolder);
  const createFolder = useMediaPoolStore((s) => s.createFolder);

  const [search, setSearch] = useState('');
  const [activeFolder, setActiveFolder] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  const [addingId, setAddingId] = useState<string | null>(null);
  // `undefined` = closed; `null` = open, creating at the pool root; a string
  // = open, creating nested inside that folder (D-056).
  const [newFolderParent, setNewFolderParent] = useState<string | null | undefined>(undefined);

  useEffect(() => {
    if (projectOpen) void refresh();
  }, [projectOpen, refresh]);

  const tree = useMemo(() => buildFolderTree(folders), [folders]);

  const doCreateFolder = async (fullPath: string) => {
    const res = await createFolder(fullPath);
    if (!res.ok) toast.error(`Couldn't create folder: ${res.error}`);
    else setNewFolderParent(undefined);
  };

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

      <ContextMenu>
        <ContextMenuTrigger>
          <div className="shrink-0 max-h-32 overflow-y-auto px-1 py-1 border-b border-border-color">
            <div className="flex items-center">
              <div
                role="button"
                tabIndex={0}
                onClick={() => setActiveFolder(null)}
                className={cn(
                  'flex-1 flex items-center gap-1 py-1 pl-1.5 pr-2 rounded text-[11px] cursor-pointer select-none',
                  activeFolder === null
                    ? 'bg-accent/15 text-text-primary'
                    : 'text-text-secondary hover:text-text-primary hover:bg-surface-hover',
                )}
              >
                <Film className="size-3" /> All media
              </div>
              <button
                onClick={() => setNewFolderParent(null)}
                title="New folder"
                aria-label="New folder"
                className="shrink-0 size-5 mr-1 rounded flex items-center justify-center text-text-secondary hover:text-text-primary hover:bg-surface-hover"
              >
                <FolderPlus className="size-3" />
              </button>
            </div>
            {tree.map((n) => (
              <FolderRow
                key={n.path}
                node={n}
                depth={0}
                activeFolder={activeFolder}
                setActiveFolder={setActiveFolder}
                onDropMedia={doMove}
                onNewFolder={setNewFolderParent}
              />
            ))}
          </div>
        </ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuItem onClick={() => setNewFolderParent(null)}>
            <FolderPlus className="size-3.5" /> New folder
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>

      {newFolderParent !== undefined && (
        <NewFolderDialog
          parentPath={newFolderParent}
          onClose={() => setNewFolderParent(undefined)}
          onCreate={doCreateFolder}
        />
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
                  {it.thumb ? (
                    <img
                      src={it.thumb}
                      alt=""
                      draggable={false}
                      className="absolute inset-0 h-full w-full object-cover"
                    />
                  ) : (
                    <Film className="size-4 text-text-secondary/50" />
                  )}
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
