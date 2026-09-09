// Apelles — the Sources / Library panel (D-046 pass 3, D-059 pass 4).
//
// Docked in the shell (via `Shell`'s `sourcesPanel` prop, wired in
// `app/src/main.tsx`) so it's reachable from every tab, not nested inside one
// tab's own panel system. Lives in `app/` rather than `@apelles/shell` because
// it needs `useSessionStore` (`_hydrateOpenDto`, for "add to grading") and
// `@apelles/editor`'s drag-to-track contract — the shell package must not
// depend on either (D-039 layer direction: app → tabs → services → domain;
// shell stays generic, same reasoning `ProjectLauncher` being injected via a
// prop already established).
//
// Contents: an Import button (native multi-select picker, same `pickClips`
// dialog `ProjectLauncher`'s "New Project" flow uses), a client-side search
// filter, a collapsible bin tree built from `useMediaPoolStore.folders`
// (D-059 — the union of explicitly-created folders and folders implied by
// `MediaItem.folder` strings, so a just-created empty folder shows up too;
// drag an item onto a folder to re-file it — `chroma_media_move`; right-click
// the tree or a folder row for "New Folder" — `chroma_media_create_folder`),
// and a grid of the pool with a real poster-frame thumbnail per item when one
// has been cached (D-059 — `MediaItem.thumb`; falls back to a placeholder
// icon otherwise) — drag a grid item onto the Edit tab's timeline to add it
// as a clip (`@apelles/editor`'s `CHROMA_MEDIA_DRAG_MIME` contract, plain
// HTML5 drag/drop, not a shared DnD context — see `TimelinePane`'s doc). A
// "+" on each item is a **convenience** that does the same thing server-side
// (D-070, `docs/notes/unified-clip-model.md`): `chroma_project_add_shot`
// appends a real `apelles_timeline::Clip` to the active timeline referencing
// this pool item — the exact same "this clip exists in my project" action as
// the drag, just reachable from the Colorist tab without switching to Edit
// first. It no longer creates a separate `ProjectShot` (retired as of D-070
// — see `chroma::project`'s module doc); "grading" and "on the Edit
// timeline" are the same thing now, there's no second list to opt into.
//
// Deletion (D-060/D-061): right-click → "Remove from pool" (D-060) plus two
// faster paths added the same session once the owner flagged right-click
// alone as "too much" — a per-card hover trash button for a single quick
// delete, and a header "Select" toggle that turns every card into a
// checkbox for a real multi-select "Select all" / "Delete N" bulk action
// (`chroma_media_remove` takes a batch of ids for exactly this, one disk
// write for the whole selection rather than one per item).
import { useEffect, useMemo, useState, type DragEvent } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { toast } from 'react-toastify';
import {
  Check,
  CheckSquare,
  ChevronRight,
  Film,
  Folder,
  FolderOpen,
  FolderPlus,
  Plus,
  Search,
  Square,
  Trash2,
  WifiOff,
  X,
} from 'lucide-react';
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
} from '@apelles/ui';
import { useMediaPoolStore } from '@apelles/bridge';
import { CHROMA_MEDIA_DRAG_MIME } from '@apelles/editor';

import { useSessionStore, type ProjectOpenDto } from '../../store/useSessionStore';
import { pickClips } from './ProjectLauncher';

// --- bin tree, built from the known folder-path strings (D-059) ------------

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
 *  (D-059) — reached from the header button or either context menu. `@apelles/ui`'s
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

/** D-097 — a compact custom drag image for a Sources-panel item, replacing
 *  the browser's default drag image (a live snapshot of the actual card DOM:
 *  full thumbnail + name + buttons). Without this, `setDragImage` is never
 *  called, so the default is whatever size the card's own CSS renders at —
 *  fixed, oblivious to the *timeline's* zoom, and absurdly oversized next to
 *  how small a clip actually looks at a low `pxPerSec` (reported live: at
 *  18% zoom the drag ghost was still the full media-pool card). Per the
 *  HTML5 DnD spec a drag image is captured once at `dragstart` and can't be
 *  resized as the pointer moves — "shrinks as you approach a low-zoom
 *  timeline" isn't achievable natively, so this is a small, fixed-size pill
 *  (name only) instead, proportionate at any zoom rather than technically
 *  accurate to it. Builds a real, briefly-attached DOM node (`setDragImage`
 *  needs one actually rendered, not just constructed) and removes it on the
 *  next tick. */
function setCompactDragImage(e: DragEvent, label: string): void {
  const el = document.createElement('div');
  el.textContent = label;
  Object.assign(el.style, {
    position: 'fixed',
    top: '-1000px',
    left: '-1000px',
    padding: '4px 8px',
    borderRadius: '4px',
    background: 'rgba(20,20,24,0.95)',
    color: '#eee',
    fontSize: '11px',
    fontFamily: 'inherit',
    whiteSpace: 'nowrap',
    pointerEvents: 'none',
  });
  document.body.appendChild(el);
  e.dataTransfer.setDragImage(el, 8, 8);
  setTimeout(() => el.remove(), 0);
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
  const removeMedia = useMediaPoolStore((s) => s.removeMedia);
  const createFolder = useMediaPoolStore((s) => s.createFolder);

  const [search, setSearch] = useState('');
  const [activeFolder, setActiveFolder] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  const [addingId, setAddingId] = useState<string | null>(null);
  // `undefined` = closed; `null` = open, creating at the pool root; a string
  // = open, creating nested inside that folder (D-059).
  const [newFolderParent, setNewFolderParent] = useState<string | null | undefined>(undefined);
  // D-061: multi-select mode — header's "Select" toggle turns every card
  // into a checkbox; `selectedIds` only matters while this is true (cleared
  // on exit so a stale selection can't silently apply to a later action).
  const [selecting, setSelecting] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

  // B-083/D-203 — the pool's own initial/after-a-switch fetch used to live
  // here, keyed on the "a project is open" boolean, which never changes when
  // one project is swapped for another (`open_project`/`new_project`), so it
  // never re-read. It's the composition root's bridge now
  // (`Root.tsx` → `useMediaPoolStore.setOpenProject`), like the Edit and
  // Motion tabs' own. What's left here is the panel-local view state that is
  // equally per-project: an active bin and a multi-selection from the OUTGOING
  // project would otherwise filter the incoming project's pool down to
  // nothing, or apply a "Delete N" to ids that are no longer in it.
  const openProjectKey = useMediaPoolStore((s) => s.openProjectKey);
  useEffect(() => {
    setActiveFolder(null);
    setSelecting(false);
    setSelectedIds(new Set());
  }, [openProjectKey]);

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

  // D-060/D-061: no confirmation dialog — matches this panel's existing
  // low-ceremony convention (New Folder has none either), and the action is
  // non-destructive to the actual file (media is always referenced in
  // place, never copied/owned — see the module doc), only to the pool's
  // reference to it.
  const doRemove = async (ids: string[], label: string) => {
    const res = await removeMedia(ids);
    if (!res.ok) toast.error(`Couldn't remove: ${res.error}`);
    else toast.success(`Removed ${label} from the pool`);
  };

  const toggleSelecting = () => {
    setSelecting((s) => !s);
    setSelectedIds(new Set());
  };

  const toggleSelected = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const allVisibleSelected = filtered.length > 0 && filtered.every((it) => selectedIds.has(it.id));
  const toggleSelectAll = () => {
    setSelectedIds(allVisibleSelected ? new Set() : new Set(filtered.map((it) => it.id)));
  };

  const doDeleteSelected = async () => {
    const ids = Array.from(selectedIds);
    if (ids.length === 0) return;
    await doRemove(ids, ids.length === 1 ? '1 clip' : `${ids.length} clips`);
    setSelectedIds(new Set());
  };

  const addToGrading = async (id: string) => {
    setAddingId(id);
    try {
      // D-070: `chroma_project_add_shot` appends a `apelles_timeline::Clip`
      // to the active timeline referencing this pool item (the same action
      // as a drag onto the Edit tab), then returns the exact same
      // `ProjectOpenDto` shape `chroma_project_open`/`_new`/`_relink` do,
      // which `_hydrateOpenDto` already knows how to consume.
      const dto = await invoke<ProjectOpenDto>('chroma_project_add_shot', { mediaId: id });
      await useSessionStore.getState()._hydrateOpenDto(dto);
      toast.success('Added to grading');
    } catch (e) {
      toast.error(`Couldn't add to grading: ${String(e)}`);
    }
      // D-201 — `try/catch` then the former `finally` body inline, not a
      // `finally` clause: the React Compiler cannot lower `finally` at all, and
      // ONE of them anywhere in a component/hook makes it skip auto-memoizing
      // the whole thing. Exactly equivalent here — the `catch` swallows
      // everything and neither block returns, so this tail is unconditionally
      // reached on both paths. See `docs/notes/react-compiler-coverage.md`.
    setAddingId(null);
    void refresh();
  };

  if (!projectOpen) return null;

  return (
    <div className="h-full w-full flex flex-col bg-surface text-text-primary">
      <div className="shrink-0 flex items-center gap-1.5 px-2.5 py-2 border-b border-border-color">
        <span className="text-[11px] font-semibold tracking-wide text-text-secondary flex-1">
          SOURCES
        </span>
        <Button
          variant={selecting ? 'secondary' : 'ghost'}
          size="xs"
          onClick={toggleSelecting}
          disabled={items.length === 0}
          className="h-6 gap-1"
        >
          <CheckSquare className="size-3" /> Select
        </Button>
        <Button variant="ghost" size="xs" onClick={doImport} disabled={importing} className="h-6 gap-1">
          <Plus className="size-3" /> Import
        </Button>
      </div>

      {selecting ? (
        // D-061: the bulk-action bar replaces the search box while
        // selecting — searching and multi-selecting-across-a-filter at the
        // same time is a real feature (D-062 candidate) this pass doesn't
        // build; simplest correct scope is "Select all" means all of
        // `filtered`, so hiding search here avoids the confusing case of a
        // stale selection referencing items the current filter now hides.
        <div className="shrink-0 flex items-center gap-1.5 px-2.5 py-1.5 border-b border-border-color bg-accent/5">
          <button
            onClick={toggleSelectAll}
            className="flex items-center gap-1.5 text-[11px] text-text-secondary hover:text-text-primary"
          >
            {allVisibleSelected ? (
              <CheckSquare className="size-3.5 text-accent" />
            ) : (
              <Square className="size-3.5" />
            )}
            Select all
          </button>
          <span className="flex-1 text-[11px] text-text-secondary">
            {selectedIds.size} selected
          </span>
          <Button
            variant="destructive"
            size="xs"
            onClick={() => void doDeleteSelected()}
            disabled={selectedIds.size === 0}
            className="h-6 gap-1"
          >
            <Trash2 className="size-3" /> Delete{selectedIds.size > 0 ? ` (${selectedIds.size})` : ''}
          </Button>
          <button
            onClick={toggleSelecting}
            title="Cancel"
            aria-label="Cancel selection"
            className="shrink-0 size-5 rounded flex items-center justify-center text-text-secondary hover:text-text-primary hover:bg-surface-hover"
          >
            <X className="size-3.5" />
          </button>
        </div>
      ) : (
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
      )}

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
            {filtered.map((it) => {
              const isSelected = selectedIds.has(it.id);
              return (
                <ContextMenu key={it.id}>
                  <ContextMenuTrigger>
                    <div
                      draggable={!selecting}
                      onDragStart={(e) => {
                        e.dataTransfer.effectAllowed = 'copy';
                        e.dataTransfer.setData(
                          CHROMA_MEDIA_DRAG_MIME,
                          JSON.stringify({
                            id: it.id,
                            sourcePath: it.sourcePath,
                            name: it.name,
                            frameCount: it.video?.frameCount ?? null,
                            // D-129 — lets the drop build a linked audio half
                            // for a source that really has one. `null` (a pool
                            // item not yet resolved by `chroma_media_list`'s
                            // one-time backfill) means "unknown", and the drop
                            // conservatively creates no audio half.
                            hasAudio: it.video?.hasAudio ?? null,
                            // B-075/D-193 — the source's real frame rate, so a
                            // dropped clip's `source_start`/`duration` convert
                            // to real seconds at export time instead of being
                            // silently misread at the project/export fps.
                            fps: it.video?.fps ?? null,
                          }),
                        );
                        setCompactDragImage(e, it.name);
                      }}
                      onClick={() => selecting && toggleSelected(it.id)}
                      title={it.sourcePath}
                      className={cn(
                        'group relative flex flex-col gap-1 rounded-md border p-1.5 hover:border-accent/60',
                        selecting ? 'cursor-pointer' : 'cursor-grab active:cursor-grabbing',
                        isSelected ? 'border-accent bg-accent/10' : 'border-border-color bg-bg-primary',
                      )}
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
                      {selecting ? (
                        // D-061: a real checkbox, always visible (not just
                        // on hover) — the whole point of selection mode is
                        // seeing at a glance what's selected before
                        // committing to Delete.
                        <div
                          className={cn(
                            'absolute top-1 left-1 size-5 rounded flex items-center justify-center border',
                            isSelected
                              ? 'bg-accent border-accent text-white'
                              : 'bg-bg-primary/90 border-border-color text-transparent',
                          )}
                        >
                          <Check className="size-3" />
                        </div>
                      ) : (
                        <>
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              void doRemove([it.id], it.name);
                            }}
                            title="Remove from pool"
                            aria-label={`Remove ${it.name} from the pool`}
                            className="absolute top-1 left-1 size-5 rounded-full bg-bg-primary/90 border border-border-color flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity hover:border-destructive hover:text-destructive"
                          >
                            <Trash2 className="size-3" />
                          </button>
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              void addToGrading(it.id);
                            }}
                            disabled={addingId === it.id || it.offline}
                            title="Add to grading"
                            aria-label={`Add ${it.name} to grading`}
                            className="absolute top-1 right-1 size-5 rounded-full bg-bg-primary/90 border border-border-color flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity disabled:opacity-40 hover:border-accent"
                          >
                            <Plus className="size-3" />
                          </button>
                        </>
                      )}
                    </div>
                  </ContextMenuTrigger>
                  <ContextMenuContent>
                    <ContextMenuItem onClick={() => void doRemove([it.id], it.name)} variant="destructive">
                      <Trash2 className="size-3.5" /> Remove from pool
                    </ContextMenuItem>
                  </ContextMenuContent>
                </ContextMenu>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
