/**
 * @apelles/keymap — the Keyboard Shortcuts settings window (D-273).
 *
 * **What it is.** The one surface where every shortcut in Apelles can be seen
 * and rebound. Shell-level, so it opens the same way from all three tabs —
 * before D-273 the only remap UI in the app was a section buried inside
 * Colorist's own settings modal, listing Colorist's 45 actions and nothing
 * else, unreachable without switching tabs first.
 *
 * **Interaction reference.** macOS System Settings ▸ Keyboard ▸ Keyboard
 * Shortcuts, the pane the owner cited in the original D-273 request. Four
 * things came from it directly (CLAUDE.md's research-the-real-pattern rule)
 * and are UNCHANGED by the D-278 layout pass below:
 *
 *   - **Categories, then rows.** Shortcuts group under named sections rather
 *     than one long alphabetical list. Here the sections are
 *     `SHORTCUT_CATEGORIES` and they carry the tab they belong to as a tag,
 *     because Apelles' three tabs each have their own set — the one thing
 *     macOS's pane has no equivalent of.
 *   - **The combo IS the control.** Each row is `label … [⌘K]`, and you click
 *     the combo itself to change it; there is no separate "edit" button. The
 *     chip goes into a recording state and takes the next chord you press.
 *   - **Escape clears rather than cancels**, leaving the action unassigned —
 *     the pane's own behaviour, and why an override of `[]` is a real stored
 *     value in `store.ts` rather than a missing one.
 *   - **"Restore Defaults" is one button for the whole pane**, not a per-row
 *     reset. A per-row reset is added anyway (the ↺ on a modified row) because
 *     this list is ~60 rows against macOS's dozen, and nuking all of them to
 *     undo one is a worse trade at that size.
 *
 * **Layout reference (D-278).** The single stacked column above read as too
 * sparse for ~60 rows across 9 categories — the owner's own reference this
 * time was a Figma community "Keyboard Shortcuts Collection" cheat sheet
 * (`scratch/keyboard-shortcuts-figma-reference.png`): a dense, multi-column
 * grid, each row a plain `label … [chip]` pair, minimal chrome, categories
 * flowing down the page rather than stacking in one tall list. The dialog
 * widened (`max-w-5xl`) and the category list now renders inside a CSS
 * multi-column flow (`columns-1 sm:columns-2 lg:columns-3`, each `<section>`
 * `break-inside-avoid`) instead of a single `<div>` stack — this balances the
 * 9 categories' uneven row counts (3 to 12 rows each) across columns on its
 * own, the same "let the browser flow it" trick the reference sheet itself
 * uses, rather than hand-bucketing categories into fixed columns. Per-row
 * borders and the sticky category header are dropped (sticky headers fight a
 * multi-column flow — each column reaches a given header at a different
 * scroll offset, so they'd stack on top of one another) in favour of a plain
 * underline below each category's own header, closer to the reference's
 * minimal-chrome rows. `docs/08-decisions.md` D-278 has the full
 * column-count reasoning.
 *
 * **What it does NOT do.** It performs no shortcut and owns no binding — it
 * reads `SHORTCUT_DEFINITIONS` and writes `useKeymapStore`. It is also not
 * where a shortcut becomes live: that is `useShortcut`.
 *
 * `translate` is injected rather than imported (the app passes i18next's `t`)
 * so the fork's 13 translated locales keep rendering translated Colorist rows
 * without this package depending on i18next — the same dependency-injection
 * pattern `Shell` uses for `launcher`/`sourcesPanel`.
 */

import { useEffect, useMemo, useState } from 'react';
import { RotateCcw } from 'lucide-react';
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@apelles/ui';

import { formatCombo, isCompleteCombo, normalizeCombo } from './combo';
import { conflictingIds, effectiveCombo, useKeymapStore } from './store';
import { SHORTCUT_CATEGORIES, SHORTCUT_DEFINITIONS, type ShortcutDefinition } from './shortcuts';

const SCOPE_TAGS: Record<string, string> = {
  global: 'All tabs',
  edit: 'Edit',
  motion: 'Motion',
  colorist: 'Colorist',
};

export interface KeyboardShortcutsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** i18next's `t`, injected by the app. Omit to render the English labels. */
  translate?: (key: string) => string;
}

export function KeyboardShortcutsDialog({ open, onOpenChange, translate }: KeyboardShortcutsDialogProps) {
  const overrides = useKeymapStore((s) => s.overrides);
  const osPlatform = useKeymapStore((s) => s.osPlatform);
  const setBinding = useKeymapStore((s) => s.setBinding);
  const resetBinding = useKeymapStore((s) => s.resetBinding);
  const resetAll = useKeymapStore((s) => s.resetAll);
  const [recording, setRecording] = useState<string | null>(null);

  const conflicts = useMemo(() => conflictingIds(overrides), [overrides]);
  const label = (def: ShortcutDefinition) => (def.labelKey && translate ? translate(def.labelKey) : def.label);

  // Stop recording whenever the window closes, so reopening it never lands
  // straight back in a half-finished capture.
  useEffect(() => {
    if (!open) setRecording(null);
  }, [open]);

  // The capture-phase listener that eats the chord being recorded. Capture and
  // `stopPropagation` are both required: the app's own dispatcher is listening
  // on `window` too, and without this, recording ⌘1 would ALSO switch tabs.
  useEffect(() => {
    if (recording === null) return;
    const onKeyDown = (event: KeyboardEvent) => {
      event.preventDefault();
      event.stopPropagation();
      if (event.key === 'Escape') {
        // macOS's own behaviour: Escape leaves the action unassigned.
        setBinding(recording, []);
        setRecording(null);
        return;
      }
      const combo = normalizeCombo(event, osPlatform);
      // Ignore the modifier-only frames while a chord is still being built up.
      if (!isCompleteCombo(combo)) return;
      setBinding(recording, combo);
      setRecording(null);
    };
    window.addEventListener('keydown', onKeyDown, { capture: true });
    return () => window.removeEventListener('keydown', onKeyDown, { capture: true });
  }, [recording, osPlatform, setBinding]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-5xl">
        <DialogHeader>
          <DialogTitle>Keyboard Shortcuts</DialogTitle>
          <DialogDescription>
            Click a shortcut to record a new one. Press Esc while recording to leave an action unassigned.
          </DialogDescription>
        </DialogHeader>

        <div className="max-h-[75vh] overflow-y-auto pr-1" data-chroma-panel="keyboard-shortcuts">
          <div className="columns-1 gap-x-8 sm:columns-2 lg:columns-3">
            {SHORTCUT_CATEGORIES.map((category) => {
              const defs = SHORTCUT_DEFINITIONS.filter((d) => d.category === category.id);
              if (defs.length === 0) return null;
              return (
                <section key={category.id} className="mb-4 break-inside-avoid">
                  <header className="mb-1 flex items-baseline gap-2 border-b border-border-color/60 pb-1">
                    <h3 className="text-[11px] font-semibold uppercase tracking-wide text-text-primary">
                      {category.labelKey && translate ? translate(category.labelKey) : category.label}
                    </h3>
                    <span className="text-[10px] text-text-secondary">{SCOPE_TAGS[category.scope]}</span>
                  </header>
                  <ul>
                    {defs.map((def) => (
                      <ShortcutRow
                        key={def.id}
                        def={def}
                        label={label(def)}
                        combo={effectiveCombo(def, overrides)}
                        modified={def.id in overrides}
                        conflicting={conflicts.has(def.id)}
                        recording={recording === def.id}
                        osPlatform={osPlatform}
                        onRecord={() => setRecording(def.id)}
                        onReset={() => resetBinding(def.id)}
                      />
                    ))}
                  </ul>
                </section>
              );
            })}
          </div>
        </div>

        <DialogFooter>
          <Button variant="ghost" size="sm" onClick={() => resetAll()}>
            Restore Defaults
          </Button>
          <Button size="sm" onClick={() => onOpenChange(false)}>
            Done
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

interface ShortcutRowProps {
  def: ShortcutDefinition;
  label: string;
  combo: string[] | null;
  modified: boolean;
  conflicting: boolean;
  recording: boolean;
  osPlatform: string;
  onRecord: () => void;
  onReset: () => void;
}

function ShortcutRow({
  def,
  label,
  combo,
  modified,
  conflicting,
  recording,
  osPlatform,
  onRecord,
  onReset,
}: ShortcutRowProps) {
  return (
    <li className="flex items-center justify-between gap-2 py-1">
      <span className="truncate text-xs text-text-primary" title={label}>
        {label}
      </span>
      <span className="flex items-center gap-1 shrink-0">
        {conflicting && !recording && (
          <span
            className="text-[10px] text-yellow-400"
            title="Another action in this tab uses the same combination — only one of them will fire."
          >
            ⚠
          </span>
        )}
        {modified && !recording && (
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={`Reset ${label} to default`}
            title="Reset to default"
            onClick={onReset}
          >
            <RotateCcw className="size-3" />
          </Button>
        )}
        <button
          type="button"
          onClick={onRecord}
          aria-label={`Change shortcut for ${label}`}
          data-chroma-shortcut={def.id}
          className={
            'min-w-[5.5rem] rounded-md border px-2 py-1 text-[11px] font-semibold transition-colors ' +
            (recording
              ? 'animate-pulse border-accent bg-bg-primary text-accent'
              : conflicting
                ? 'border-yellow-400 bg-bg-primary text-text-primary hover:border-accent'
                : 'border-border-color bg-bg-primary text-text-primary hover:border-accent')
          }
        >
          {recording ? (
            'Press keys…'
          ) : combo ? (
            formatCombo(combo, osPlatform)
          ) : (
            <span className="italic text-text-secondary">Not assigned</span>
          )}
        </button>
      </span>
    </li>
  );
}
