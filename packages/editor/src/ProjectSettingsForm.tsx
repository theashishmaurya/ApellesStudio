/**
 * @apelles/editor — the project-level output-spec controls: Resolution,
 * Frame Rate, Colour Space (D-038's `ProjectSettings`), factored out as one
 * pure, controlled form (D-272).
 *
 * **Why this exists.** The Colorist tab's `ProjectSettingsModal.tsx`
 * (`app/src/components/chroma`) and the Edit tab's docked
 * `ProjectSettingsPanel.tsx` (this package) both need to show and edit the
 * SAME three fields. Rather than one owning the fields and the other
 * duplicating them (or importing across the D-039 layer boundary — `app`
 * may import from `@apelles/editor`, never the reverse), this component is
 * the one place those controls are defined; each caller renders it inside
 * whatever chrome it needs (a `Dialog` there, an always-visible Inspector
 * section here) and supplies `settings`/`onChange` itself.
 *
 * **Pure presentation**, `ClipInspectorPanel`'s own contract: takes
 * `settings` and a merge-patch `onChange`, owns no IO. Every edit fires
 * `onChange` immediately — instant-apply, like every other Inspector row in
 * this package — so there is no local draft and no Save button. That is
 * what lets the identical component sit permanently docked with nothing
 * pending to lose on navigate-away; see D-272 for why the modal moved from
 * its previous staged Save/Cancel to this shape too, rather than the docked
 * panel growing an out-of-place Save button instead.
 *
 * `resMode`/`fpsMode` (which of "match / preset / custom" is showing) ARE
 * local component state, for the same reason `ClipInspectorPanel`'s own
 * `ratioLocked` is (D-193): a UI PRESENTATION choice, not project data —
 * "was Custom selected" carries no information a future session needs back.
 * Deriving it purely from the numbers would also make "Custom" unreachable
 * once the typed values happen to equal a preset exactly. Seeded once from
 * the incoming `settings` (`ProjectSettingsModal`'s own pre-D-272 behaviour,
 * unchanged by this pass) rather than kept in sync with every later external
 * change — snapping the mode selector out from under a user mid-interaction
 * because another surface (or MCP) wrote in the background would be worse
 * than the rare staleness.
 */
import { useState } from 'react';
import {
  Button,
  ScrubbableNumberInput,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@apelles/ui';

/** Mirrors `crate::apelles_project::ProjectSettings` (`crates/apelles-project/
 *  src/manifest.rs`) and its own `merge_patch` contract exactly: every field
 *  optional, `null`/absent meaning "derive from the project's first clip".
 *  Canonical HERE (this package, D-039's lower layer) — `app/src/store/
 *  useSessionStore.ts`'s own `ProjectSettings` is a type alias of this one
 *  rather than a second, hand-kept-in-sync copy (see D-272). */
export interface ProjectSettingsValue {
  width?: number | null;
  height?: number | null;
  fps?: number | null;
  colorSpace?: string | null;
}

const RES_PRESETS: { label: string; w: number; h: number }[] = [
  { label: '3840×2160 (UHD)', w: 3840, h: 2160 },
  { label: '1920×1080 (HD)', w: 1920, h: 1080 },
  { label: '1280×720', w: 1280, h: 720 },
  { label: '1080×1920 (vertical)', w: 1080, h: 1920 },
];

const FPS_PRESETS = [23.976, 24, 25, 29.97, 30, 50, 59.94, 60];

const COLOR_SPACES: { value: string; label: string }[] = [
  { value: 'rec709', label: 'Rec.709' },
  { value: 'rec2020', label: 'Rec.2020' },
  { value: 'dci-p3', label: 'DCI-P3' },
  { value: 'srgb', label: 'sRGB' },
];

function matchesResPreset(w?: number | null, h?: number | null): number {
  return RES_PRESETS.findIndex((p) => p.w === w && p.h === h);
}

type Mode = 'match' | 'preset' | 'custom';

function inferResMode(settings: ProjectSettingsValue): Mode {
  if (settings.width == null || settings.height == null) return 'match';
  return matchesResPreset(settings.width, settings.height) >= 0 ? 'preset' : 'custom';
}

function inferFpsMode(settings: ProjectSettingsValue): Mode {
  if (settings.fps == null) return 'match';
  return FPS_PRESETS.includes(settings.fps) ? 'preset' : 'custom';
}

const MODES: readonly Mode[] = ['match', 'preset', 'custom'];
const MODE_LABEL: Readonly<Record<Mode, string>> = {
  match: 'Match first clip',
  preset: 'Preset',
  custom: 'Custom',
};

const pillClass = (active: boolean): string =>
  `px-2 py-1 rounded-md border text-[11px] ${
    active
      ? 'border-accent text-text-primary bg-accent/10'
      : 'border-border-color text-text-secondary hover:text-text-primary'
  }`;

export function ProjectSettingsForm({
  settings,
  onChange,
  disabled,
}: {
  settings: ProjectSettingsValue;
  /** Merge-patch, mirroring `chroma_project_set_settings`'s own contract: a
   *  present key is applied (`null` clears it), an absent key is left
   *  alone. Fired once per user edit — never debounced or batched — so the
   *  caller's own single write-and-broadcast path (`useProjectSettings`'s
   *  `save`, or the Colorist modal's `setProjectSettings`) is always what
   *  actually changes the project. */
  onChange: (patch: ProjectSettingsValue) => void;
  disabled?: boolean;
}) {
  const [resMode, setResMode] = useState<Mode>(() => inferResMode(settings));
  const [fpsMode, setFpsMode] = useState<Mode>(() => inferFpsMode(settings));

  // Fallback seeds for switching INTO "Custom" from "Match" (no numbers to
  // start from yet) — the last preset/value on screen when one exists,
  // otherwise a plain 1920x1080 / 24fps default. Never used to overwrite an
  // already-custom value.
  const customWidth = settings.width ?? 1920;
  const customHeight = settings.height ?? 1080;
  const customFps = settings.fps ?? 24;

  return (
    <div className="flex flex-col gap-4 text-xs">
      <div className="flex flex-col gap-1.5">
        <span className="text-text-secondary">Resolution</span>
        <div className="flex flex-wrap gap-1.5">
          {MODES.map((m) => (
            <button
              key={m}
              type="button"
              disabled={disabled}
              className={pillClass(resMode === m)}
              onClick={() => {
                setResMode(m);
                if (m === 'match') onChange({ width: null, height: null });
                else if (m === 'custom' && settings.width == null) {
                  onChange({ width: customWidth, height: customHeight });
                }
              }}
            >
              {MODE_LABEL[m]}
            </button>
          ))}
        </div>
        {resMode === 'preset' && (
          <div className="flex flex-wrap gap-1.5">
            {RES_PRESETS.map((p) => (
              <Button
                key={p.label}
                type="button"
                variant={settings.width === p.w && settings.height === p.h ? 'default' : 'outline'}
                size="xs"
                disabled={disabled}
                className="h-6 px-2 text-[11px]"
                onClick={() => onChange({ width: p.w, height: p.h })}
              >
                {p.label}
              </Button>
            ))}
          </div>
        )}
        {resMode === 'custom' && (
          <div className="flex items-center gap-2">
            <ScrubbableNumberInput
              step={1}
              min={1}
              disabled={disabled}
              className="h-7 w-20"
              value={settings.width ?? null}
              onValueChange={(w) => onChange({ width: Math.round(w), height: settings.height ?? customHeight })}
            />
            <span className="text-text-secondary">×</span>
            <ScrubbableNumberInput
              step={1}
              min={1}
              disabled={disabled}
              className="h-7 w-20"
              value={settings.height ?? null}
              onValueChange={(h) => onChange({ width: settings.width ?? customWidth, height: Math.round(h) })}
            />
          </div>
        )}
      </div>

      <div className="flex flex-col gap-1.5">
        <span className="text-text-secondary">Frame Rate</span>
        <div className="flex flex-wrap gap-1.5">
          {MODES.map((m) => (
            <button
              key={m}
              type="button"
              disabled={disabled}
              className={pillClass(fpsMode === m)}
              onClick={() => {
                setFpsMode(m);
                if (m === 'match') onChange({ fps: null });
                else if (m === 'custom' && settings.fps == null) onChange({ fps: customFps });
              }}
            >
              {MODE_LABEL[m]}
            </button>
          ))}
        </div>
        {fpsMode === 'preset' && (
          <Select
            value={settings.fps != null && FPS_PRESETS.includes(settings.fps) ? String(settings.fps) : undefined}
            onValueChange={(v) => onChange({ fps: Number(v) })}
            disabled={disabled}
          >
            <SelectTrigger className="h-7 w-32 text-xs">
              <SelectValue placeholder="fps" />
            </SelectTrigger>
            <SelectContent>
              {FPS_PRESETS.map((f) => (
                <SelectItem key={f} value={String(f)}>
                  {f} fps
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
        {fpsMode === 'custom' && (
          <ScrubbableNumberInput
            step={0.001}
            min={1}
            disabled={disabled}
            className="h-7 w-24"
            value={settings.fps ?? null}
            onValueChange={(f) => onChange({ fps: f })}
          />
        )}
      </div>

      <div className="flex flex-col gap-1.5">
        <span className="text-text-secondary">Colour Space</span>
        <Select
          value={settings.colorSpace ?? 'rec709'}
          onValueChange={(v) => onChange({ colorSpace: v })}
          disabled={disabled}
        >
          <SelectTrigger className="h-7 w-full text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {COLOR_SPACES.map((c) => (
              <SelectItem key={c.value} value={c.value}>
                {c.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <p className="text-text-secondary/60 text-[10px] leading-snug">
          Display / metadata only for now — the grade still renders display-referred Rec.709 (D-004).
        </p>
      </div>
    </div>
  );
}
