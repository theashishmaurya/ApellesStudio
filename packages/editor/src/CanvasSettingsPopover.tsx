/**
 * @chroma/editor — the Edit tab's own canvas (output composition)
 * width/height surface (D-199, `docs/notes/preview-canvas-boundary.md`).
 *
 * **The gap this closes.** `ProjectSettings` (D-038) already has a real
 * view/edit surface — `app/src/components/chroma/ProjectSettingsModal.tsx`
 * — but it is reachable ONLY from the Colorist tab's shot-strip gear icon.
 * A project built entirely in the Edit tab (never visiting Colorist) had NO
 * way to see or change its own output width/height at all; the composition
 * size silently fell back to whichever clip happened to be first
 * (`chroma::edit::composition_size`'s own doc). `packages/editor` cannot
 * import that modal (D-039's one-way `app -> packages` dependency rule, and
 * it reads Colorist's own `useSessionStore`, which this package has no
 * access to and shouldn't) — this is a genuinely separate, lighter surface
 * for the SAME underlying `chroma_project_get_settings`/
 * `chroma_project_set_settings` commands, scoped to just the two fields
 * that define the preview's composition boundary (width/height); fps and
 * colour space stay Colorist-modal-only, since neither affects what the
 * canvas-boundary overlay or the compositor's own placement math need.
 *
 * A small `Popover` (not a full `Dialog`) — this is a quick, low-stakes
 * numeric edit, not a multi-field workflow; opened from `PreviewPane.tsx`'s
 * toolbar, next to the Inspector toggle.
 *
 * **Live update, no page reload.** Saving calls `chroma_project_set_settings`
 * directly. That Rust command itself broadcasts a `chroma://project-settings-
 * changed` Tauri event on every successful write (B-086), which
 * `useCompositionSize` listens for directly — so the boundary overlay (and
 * any future consumer of that hook) re-fetches immediately, with no callback
 * needed from this component to make it happen.
 */
import { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { Settings2 } from 'lucide-react';
import { Button, Input, Popover, PopoverContent, PopoverTrigger } from '@chroma/ui';

import { usePanelOpen } from './panelRegistry';

const RES_PRESETS: { label: string; w: number; h: number }[] = [
  { label: '3840×2160', w: 3840, h: 2160 },
  { label: '1920×1080', w: 1920, h: 1080 },
  { label: '1280×720', w: 1280, h: 720 },
  { label: '1080×1920', w: 1080, h: 1920 },
];

/** Mirrors the fields `crate::chroma_project::ProjectSettings` actually has
 *  — only `width`/`height` are this popover's concern (see module doc). */
interface ProjectSettingsWH {
  width?: number | null;
  height?: number | null;
}

export function CanvasSettingsPopover() {
  // D-252 — lifted out of local `useState` so `debug_set_popover_open
  // ('canvas-settings', ...)` can drive this same flag; see
  // `panelRegistry.ts`'s module doc.
  const [open, setOpen] = usePanelOpen('canvas-settings');
  const [loaded, setLoaded] = useState(false);
  const [width, setWidth] = useState('');
  const [height, setHeight] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Fetch the CURRENT settings fresh every time the popover opens — this
  // package has no persistent settings store of its own (see module doc),
  // and the values may have changed from the Colorist tab's own modal since
  // this popover was last open.
  useEffect(() => {
    if (!open) return;
    setLoaded(false);
    setError(null);
    let cancelled = false;
    invoke<ProjectSettingsWH>('chroma_project_get_settings', { path: null })
      .then((s) => {
        if (cancelled) return;
        setWidth(s.width != null ? String(s.width) : '');
        setHeight(s.height != null ? String(s.height) : '');
        setLoaded(true);
      })
      .catch((e) => {
        if (!cancelled) setError(String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [open]);

  const applyPreset = (w: number, h: number) => {
    setWidth(String(w));
    setHeight(String(h));
  };

  const save = async (partial: { width: number | null; height: number | null }) => {
    setSaving(true);
    setError(null);
    // D-201 — `try/catch` then the former `finally` body inline, not a
    // `finally` clause: the React Compiler cannot lower `finally` at all, and
    // one anywhere in a component makes it skip auto-memoizing the whole
    // component. Exactly equivalent here (the `catch` swallows everything and
    // neither block returns). `reactCompiler.test.ts` enforces this.
    try {
      await invoke('chroma_project_set_settings', { path: null, partial });
      setOpen(false);
    } catch (e) {
      setError(String(e));
    }
    setSaving(false);
  };

  const handleSave = () => {
    const w = width.trim() === '' ? null : Math.round(Number(width));
    const h = height.trim() === '' ? null : Math.round(Number(height));
    if ((w !== null && (!Number.isFinite(w) || w <= 0)) || (h !== null && (!Number.isFinite(h) || h <= 0))) {
      setError('width/height must be positive numbers, or blank to match the first clip');
      return;
    }
    void save({ width: w, height: h });
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      {/* D-118's Inspector toggle (`EditorTab.tsx`) is the sibling this
          matches — same corner treatment, one slot to its left (`right-10`
          vs. its `right-2`). Anchors against `PreviewPane.tsx`'s own
          top-level `relative` div (this component's parent there), which
          fills the exact same box `EditorTab.tsx`'s own `relative` wrapper
          does — so the two buttons land in the same visual corner despite
          anchoring to two different (same-sized) elements. Base UI's
          `render` prop (not Radix's `asChild`) — same pattern
          `TimelinePane.tsx`'s own duck-settings `PopoverTrigger` uses. */}
      <PopoverTrigger
        render={
          <Button
            variant="ghost"
            size="xs"
            title="Canvas size"
            aria-label="Canvas size"
            className="absolute top-2 right-10 z-10 h-6 w-6 p-0 rounded-md border border-border-color bg-surface/90 shadow-sm backdrop-blur-sm text-text-secondary hover:text-text-primary"
          >
            <Settings2 className="size-3.5" />
          </Button>
        }
      />
      <PopoverContent className="w-64 bg-surface border-border-color text-text-primary" align="end">
        <div className="flex flex-col gap-3 text-xs">
          <div className="font-medium text-text-primary">Canvas size</div>
          <p className="text-text-secondary">
            The project&apos;s output frame — every clip&apos;s Position/Scale/Width/Height is measured against this.
            Blank matches the timeline&apos;s first clip.
          </p>
          <div className="flex items-center gap-2">
            <Input
              type="number"
              placeholder="width"
              className="h-7 text-right"
              value={width}
              disabled={!loaded}
              onChange={(e) => setWidth(e.target.value)}
            />
            <span className="text-text-secondary">×</span>
            <Input
              type="number"
              placeholder="height"
              className="h-7 text-right"
              value={height}
              disabled={!loaded}
              onChange={(e) => setHeight(e.target.value)}
            />
          </div>
          <div className="flex flex-wrap gap-1">
            {RES_PRESETS.map((p) => (
              <Button
                key={p.label}
                variant="outline"
                size="xs"
                className="h-6 px-2 text-[11px]"
                onClick={() => applyPreset(p.w, p.h)}
              >
                {p.label}
              </Button>
            ))}
          </div>
          {error && <p className="text-red-400">{error}</p>}
          <div className="flex items-center justify-between gap-2 pt-1">
            <Button
              variant="ghost"
              size="xs"
              className="h-6 px-2 text-[11px]"
              disabled={saving}
              onClick={() => {
                setWidth('');
                setHeight('');
              }}
            >
              Match first clip
            </Button>
            <Button size="xs" className="h-6 px-3 text-[11px]" disabled={saving || !loaded} onClick={handleSave}>
              Apply
            </Button>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}
