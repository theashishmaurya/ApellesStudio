// Apelles — the shot strip (multi-shot session, D-033).
//
// A horizontal strip of the shots in the grading job: thumbnail + filename + a
// dot when the shot has a non-neutral grade. Click to switch (each shot keeps
// its own grade), "+" to add clips, × to remove, "copy →" to push the active
// shot's grade onto the next one. Replaces RapidRAW's folder-oriented library
// browser for the clip-oriented workflow (docs/09 "replace with a shot strip").
//
// D-070 (unified clip identity, `docs/notes/unified-clip-model.md`): for a
// real project, each `shot` here is backed by a `apelles_timeline::Clip` on
// the active Edit-tab timeline (`useSessionStore.shots`, keyed by
// `shot.id` — a clip id, not a path — see that store's module doc); "+"
// appends a new clip, "×" removes one from the timeline. Same visual shape
// as before this decision.
//
// Styling: plain elements + app colour tokens, same as ChromaTimeline /
// AgentActivityDock. Deferred (D-033 follow-ups): drag-drop reorder, a
// copy-to-any-shot picker, session-file persistence.
import { useCallback, useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { open as openDialog } from '@tauri-apps/plugin-dialog';
import { Plus, X, ArrowRight, Loader2, Link2, Save, Settings2 } from 'lucide-react';
import { toast } from 'react-toastify';

import { useSessionStore, isNonNeutralGrade } from '../../store/useSessionStore';
import { useEditorStore } from '../../store/useEditorStore';
import ProjectSettingsModal from './ProjectSettingsModal';

const VIDEO_EXTS = ['mov', 'mp4', 'm4v', 'mkv', 'webm', 'avi', 'mts', 'm2ts', 'mxf', 'braw', 'r3d'];

export default function ShotStrip() {
  const shots = useSessionStore((s) => s.shots);
  const activeIndex = useSessionStore((s) => s.activeIndex);
  const grades = useSessionStore((s) => s.grades);
  const busy = useSessionStore((s) => s.busy);
  const switchToShot = useSessionStore((s) => s.switchToShot);
  const addShots = useSessionStore((s) => s.addShots);
  const removeShot = useSessionStore((s) => s.removeShot);
  const copyGrade = useSessionStore((s) => s.copyGrade);
  const offlineShots = useSessionStore((s) => s.offlineShots);
  const projectName = useSessionStore((s) => s.projectName);
  const relinkShot = useSessionStore((s) => s.relinkShot);
  const saveUntitledAs = useSessionStore((s) => s.saveUntitledAs);
  const liveAdjustments = useEditorStore((s) => s.adjustments);

  const [thumbs, setThumbs] = useState<Record<string, string>>({});
  const [showSettings, setShowSettings] = useState(false);
  const fetching = useRef<Set<string>>(new Set());
  const hasProject = !!projectName && projectName !== 'Untitled';

  useEffect(() => {
    shots.forEach((shot, i) => {
      if (thumbs[shot.id] || fetching.current.has(shot.id)) return;
      fetching.current.add(shot.id);
      invoke<string>('chroma_session_thumbnail', { index: i, height: 96 })
        .then((url) => setThumbs((t) => ({ ...t, [shot.id]: url })))
        .catch(() => {})
        .finally(() => fetching.current.delete(shot.id));
    });
  }, [shots, thumbs]);

  const handleAdd = useCallback(async () => {
    if (busy) return;
    let selected: string | string[] | null;
    try {
      selected = await openDialog({
        multiple: true,
        title: 'Add shots to the session',
        filters: [{ name: 'Video', extensions: [...VIDEO_EXTS, ...VIDEO_EXTS.map((e) => e.toUpperCase())] }],
      });
    } catch (e) {
      console.error(e);
      return;
    }
    const paths = Array.isArray(selected) ? selected : selected ? [selected] : [];
    if (!paths.length) return;
    const res = await addShots(paths);
    if (!res.ok) toast.error(`Add shots failed: ${res.error}`);
  }, [busy, addShots]);

  const handleRemove = useCallback(
    async (i: number) => {
      const res = await removeShot(i);
      if (!res.ok) toast.error(`Remove failed: ${res.error}`);
    },
    [removeShot],
  );

  const handleRelink = useCallback(
    async (shotId: string) => {
      let selected: string | string[] | null;
      try {
        selected = await openDialog({
          multiple: false,
          title: 'Relink this shot to a new file',
          filters: [{ name: 'Video', extensions: [...VIDEO_EXTS, ...VIDEO_EXTS.map((e) => e.toUpperCase())] }],
        });
      } catch {
        return;
      }
      const next = Array.isArray(selected) ? selected[0] : selected;
      if (!next) return;
      const res = await relinkShot(shotId, next);
      if (!res.ok) toast.error(`Relink failed: ${res.error}`);
    },
    [relinkShot],
  );

  const handleSaveUntitled = useCallback(async () => {
    const name = window.prompt('Save this session as a project. Name:');
    if (!name || !name.trim()) return;
    const res = await saveUntitledAs(name.trim());
    if (!res.ok) toast.error(`Save failed: ${res.error}`);
    else toast.success(`Saved project "${name.trim()}"`);
  }, [saveUntitledAs]);

  if (shots.length === 0 && offlineShots.length === 0) return null;

  return (
    <div className="w-full flex items-stretch gap-1.5 px-2 pt-2 overflow-x-auto select-none">
      {projectName === 'Untitled' && (
        <button
          onClick={handleSaveUntitled}
          title="This session isn't saved as a project yet"
          className="shrink-0 self-center flex items-center gap-1.5 px-2 py-1 rounded-md border border-dashed border-accent/60 text-[11px] text-accent hover:bg-accent/10"
        >
          <Save size={12} /> Save project
        </button>
      )}
      {hasProject && (
        <button
          onClick={() => setShowSettings(true)}
          title="Project settings — output resolution, frame rate, colour space"
          className="shrink-0 self-center flex items-center gap-1.5 px-2 py-1 rounded-md border border-surface text-[11px] text-text-secondary hover:text-text-primary hover:border-text-secondary"
        >
          <Settings2 size={12} /> Settings
        </button>
      )}
      {showSettings && <ProjectSettingsModal onClose={() => setShowSettings(false)} />}
      {shots.map((shot, i) => {
        const active = i === activeIndex;
        const grade = active ? liveAdjustments : grades[shot.id];
        const hasGrade = isNonNeutralGrade(grade);
        return (
          <div
            key={shot.id}
            onClick={() => !active && !busy && switchToShot(i).then((r) => !r.ok && r.error && toast.error(r.error))}
            title={shot.path}
            className={[
              'group relative shrink-0 w-28 rounded-md overflow-hidden cursor-pointer border transition-colors',
              active ? 'border-accent' : 'border-surface hover:border-text-secondary',
            ].join(' ')}
          >
            <div className="relative h-16 bg-bg-primary">
              {thumbs[shot.id] ? (
                <img src={thumbs[shot.id]} draggable={false} className="w-full h-full object-cover pointer-events-none" />
              ) : (
                <div className="w-full h-full flex items-center justify-center">
                  <Loader2 size={14} className="animate-spin text-text-secondary" />
                </div>
              )}
              {hasGrade && (
                <span
                  className="absolute top-1 left-1 w-2 h-2 rounded-full bg-accent ring-1 ring-black/40"
                  title="has a non-neutral grade"
                />
              )}
              {shots.length > 1 && (
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    handleRemove(i);
                  }}
                  title="Remove shot from session"
                  className="absolute top-0.5 right-0.5 p-0.5 rounded bg-black/50 text-white opacity-0 group-hover:opacity-100 hover:bg-black/80"
                >
                  <X size={11} />
                </button>
              )}
              {active && i < shots.length - 1 && (
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    copyGrade(i, i + 1);
                    toast.info(`Grade copied to ${shots[i + 1].name}`);
                  }}
                  title="Copy this grade to the next shot"
                  className="absolute bottom-0.5 right-0.5 p-0.5 rounded bg-black/50 text-white opacity-0 group-hover:opacity-100 hover:bg-black/80"
                >
                  <ArrowRight size={11} />
                </button>
              )}
            </div>
            <div
              className={[
                'px-1.5 py-1 text-[10px] truncate',
                active ? 'text-text-primary bg-surface' : 'text-text-secondary bg-bg-secondary',
              ].join(' ')}
            >
              {shot.name}
            </div>
          </div>
        );
      })}

      {offlineShots.map((o) => (
        <div
          key={o.id}
          title={`Media offline: ${o.sourcePath}`}
          className="group relative shrink-0 w-28 rounded-md overflow-hidden border border-amber-500/50"
        >
          <div className="relative h-16 bg-bg-primary flex items-center justify-center">
            <span className="text-[10px] text-amber-400 px-1 text-center leading-tight">media offline</span>
            <button
              onClick={() => handleRelink(o.id)}
              title="Relink to a new file"
              className="absolute bottom-0.5 right-0.5 p-0.5 rounded bg-black/50 text-white opacity-0 group-hover:opacity-100 hover:bg-black/80"
            >
              <Link2 size={11} />
            </button>
          </div>
          <div className="px-1.5 py-1 text-[10px] truncate text-text-secondary bg-bg-secondary">{o.name}</div>
        </div>
      ))}

      <button
        onClick={handleAdd}
        disabled={busy}
        title="Add shots to the session"
        className="shrink-0 w-12 rounded-md border border-dashed border-surface hover:border-text-secondary text-text-secondary hover:text-text-primary flex items-center justify-center disabled:opacity-40"
      >
        {busy ? <Loader2 size={16} className="animate-spin" /> : <Plus size={16} />}
      </button>
    </div>
  );
}
