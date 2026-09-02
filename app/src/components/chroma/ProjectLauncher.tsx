// Chroma — the project launcher (D-037).
//
// Replaces RapidRAW's inherited folder-browser + photo-grid Library view as the
// default landing screen. A grid of saved Chroma projects (`~/Movies/Chroma/
// *.chroma`), each a card with a cached thumbnail + name + relative timestamp;
// click to open it in the editor. "＋ New Project" picks clips and scaffolds a
// new `<name>.chroma`. RapidRAW's LibraryView / albums / culling still exist —
// they're just not routed to by default (docs/09 divergence log, D-003).
//
// Styling: plain elements + app colour tokens, same as ShotStrip / AgentActivityDock.
import { useCallback, useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { open as openDialog } from '@tauri-apps/plugin-dialog';
import { homeDir } from '@tauri-apps/api/path';
import { FolderOpen, Plus, Film, Loader2, X } from 'lucide-react';
import { toast } from 'react-toastify';

import { useSessionStore } from '../../store/useSessionStore';
import { useUIStore } from '../../store/useUIStore';

const VIDEO_EXTS = ['mov', 'mp4', 'm4v', 'mkv', 'webm', 'avi', 'mts', 'm2ts', 'mxf', 'braw', 'r3d'];

interface ProjectSummary {
  name: string;
  path: string;
  modified: string;
  modifiedEpoch: number;
  shotCount: number;
  thumb?: string;
}

function relTime(ms: number): string {
  if (!ms) return '';
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 45) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m} minute${m === 1 ? '' : 's'} ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} hour${h === 1 ? '' : 's'} ago`;
  const d = Math.round(h / 24);
  if (d < 30) return `${d} day${d === 1 ? '' : 's'} ago`;
  const mo = Math.round(d / 30);
  if (mo < 12) return `${mo} month${mo === 1 ? '' : 's'} ago`;
  const y = Math.round(mo / 12);
  return `${y} year${y === 1 ? '' : 's'} ago`;
}

async function pickClips(): Promise<string[]> {
  try {
    const sel = await openDialog({
      multiple: true,
      title: 'Pick clips for the project',
      filters: [{ name: 'Video', extensions: [...VIDEO_EXTS, ...VIDEO_EXTS.map((e) => e.toUpperCase())] }],
    });
    return Array.isArray(sel) ? sel : sel ? [sel] : [];
  } catch {
    return [];
  }
}

function NewProjectModal({ onClose }: { onClose: () => void }) {
  const [name, setName] = useState('');
  const [paths, setPaths] = useState<string[]>([]);
  const [creating, setCreating] = useState(false);
  const newProject = useSessionStore((s) => s.newProject);
  const setUI = useUIStore((s) => s.setUI);

  const create = useCallback(async () => {
    if (!name.trim()) {
      toast.error('Give the project a name.');
      return;
    }
    setCreating(true);
    const res = await newProject(name.trim(), paths);
    setCreating(false);
    if (!res.ok) {
      toast.error(`Create failed: ${res.error}`);
      return;
    }
    onClose();
    setUI({ activeView: 'editor' });
  }, [name, paths, newProject, onClose, setUI]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={onClose}>
      <div
        className="w-[440px] max-w-[calc(100vw-32px)] rounded-lg border border-border-color bg-surface p-5 shadow-2xl flex flex-col gap-4"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold text-text-primary">New project</h2>
          <button onClick={onClose} className="text-text-secondary hover:text-text-primary">
            <X size={16} />
          </button>
        </div>

        <label className="flex flex-col gap-1.5">
          <span className="text-xs text-text-secondary">Name</span>
          <input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && create()}
            placeholder="Beach shoot"
            className="px-2.5 py-1.5 rounded-md bg-bg-primary border border-border-color text-sm text-text-primary outline-none focus:border-accent"
          />
        </label>

        <div className="flex flex-col gap-1.5">
          <span className="text-xs text-text-secondary">Clips ({paths.length})</span>
          <button
            onClick={async () => setPaths(await pickClips())}
            className="self-start px-2.5 py-1.5 rounded-md bg-bg-primary border border-border-color text-xs text-text-primary hover:border-accent flex items-center gap-1.5"
          >
            <Film size={13} /> {paths.length ? 'Change clips' : 'Pick clips'}
          </button>
          {paths.length > 0 && (
            <div className="max-h-24 overflow-y-auto text-[11px] text-text-secondary flex flex-col gap-0.5">
              {paths.map((p) => (
                <span key={p} className="truncate" title={p}>
                  {p.split(/[\\/]/).pop()}
                </span>
              ))}
            </div>
          )}
          <span className="text-[11px] text-text-secondary/70">
            You can also add clips later from the shot strip. Media is referenced in place — never copied.
          </span>
        </div>

        <div className="flex justify-end gap-2 pt-1">
          <button onClick={onClose} className="px-3 py-1.5 rounded-md text-xs text-text-secondary hover:text-text-primary">
            Cancel
          </button>
          <button
            onClick={create}
            disabled={creating}
            className="px-3 py-1.5 rounded-md text-xs font-semibold bg-accent text-button-text hover:opacity-90 disabled:opacity-50 flex items-center gap-1.5"
          >
            {creating && <Loader2 size={13} className="animate-spin" />} Create
          </button>
        </div>
      </div>
    </div>
  );
}

function ProjectCard({ p, onOpen }: { p: ProjectSummary; onOpen: () => void }) {
  return (
    <button
      onClick={onOpen}
      title={p.path}
      className="group flex flex-col rounded-lg overflow-hidden border border-border-color bg-surface text-left hover:border-accent transition-colors"
    >
      <div className="aspect-video bg-bg-primary flex items-center justify-center overflow-hidden">
        {p.thumb ? (
          <img src={p.thumb} draggable={false} className="w-full h-full object-cover" />
        ) : (
          <Film size={22} className="text-text-secondary/50" />
        )}
      </div>
      <div className="px-3 py-2">
        <div className="text-sm font-medium text-text-primary truncate">{p.name}</div>
        <div className="text-[11px] text-text-secondary mt-0.5">
          {relTime(p.modifiedEpoch)}
          {p.shotCount ? ` · ${p.shotCount} shot${p.shotCount === 1 ? '' : 's'}` : ''}
        </div>
      </div>
    </button>
  );
}

export default function ProjectLauncher() {
  const [projects, setProjects] = useState<ProjectSummary[] | null>(null);
  const [dir, setDir] = useState('');
  const [showNew, setShowNew] = useState(false);
  const openProject = useSessionStore((s) => s.openProject);
  const setUI = useUIStore((s) => s.setUI);

  const refresh = useCallback(async () => {
    try {
      const [list, folder] = await Promise.all([
        invoke<ProjectSummary[]>('chroma_project_list'),
        invoke<string>('chroma_project_settings_dir'),
      ]);
      setProjects(list);
      setDir(folder);
    } catch (e) {
      console.error(e);
      setProjects([]);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const changeFolder = useCallback(async () => {
    let selected: string | string[] | null;
    try {
      selected = await openDialog({ directory: true, multiple: false, defaultPath: dir || (await homeDir()) });
    } catch {
      return;
    }
    const next = Array.isArray(selected) ? selected[0] : selected;
    if (!next) return;
    try {
      await invoke('chroma_project_set_dir', { dir: next });
      await refresh();
    } catch (e: any) {
      toast.error(`Could not set projects folder: ${String(e?.message || e)}`);
    }
  }, [dir, refresh]);

  const handleOpen = useCallback(
    async (path: string) => {
      const res = await openProject(path);
      if (!res.ok) {
        toast.error(`Open failed: ${res.error}`);
        return;
      }
      setUI({ activeView: 'editor' });
    },
    [openProject, setUI],
  );

  return (
    <div className="flex-1 h-full overflow-y-auto bg-bg-primary custom-scrollbar">
      <div className="max-w-5xl mx-auto px-8 py-10 flex flex-col gap-8">
        <div>
          <h1 className="text-2xl font-semibold text-text-primary">Welcome to Chroma</h1>
          <p className="text-sm text-text-secondary mt-1">Open a project to pick up where you left off, or start a new one.</p>
        </div>

        <div className="flex items-center justify-between gap-3 flex-wrap">
          <h2 className="text-sm font-semibold text-text-primary">My Projects</h2>
          <button
            onClick={changeFolder}
            title="Change where projects are stored"
            className="flex items-center gap-1.5 text-[11px] text-text-secondary hover:text-text-primary"
          >
            <FolderOpen size={13} />
            <span className="truncate max-w-[340px]">{dir || '~/Movies/Chroma'}</span>
          </button>
        </div>

        {projects === null ? (
          <div className="flex items-center gap-2 text-text-secondary text-sm">
            <Loader2 size={14} className="animate-spin" /> Loading…
          </div>
        ) : (
          <div className="grid grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-4">
            <button
              onClick={() => setShowNew(true)}
              className="aspect-video rounded-lg border border-dashed border-border-color bg-surface/40 flex flex-col items-center justify-center gap-2 text-text-secondary hover:text-text-primary hover:border-accent transition-colors"
            >
              <Plus size={22} />
              <span className="text-xs font-medium">New Project</span>
            </button>
            {projects.map((p) => (
              <ProjectCard key={p.path} p={p} onOpen={() => handleOpen(p.path)} />
            ))}
          </div>
        )}

        {projects !== null && projects.length === 0 && (
          <p className="text-xs text-text-secondary/70 -mt-4">
            No projects yet in <span className="font-mono">{dir}</span>. Create one above.
          </p>
        )}
      </div>

      {showNew && <NewProjectModal onClose={() => setShowNew(false)} />}
    </div>
  );
}
