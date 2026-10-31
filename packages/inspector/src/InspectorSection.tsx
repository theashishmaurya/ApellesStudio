/**
 * @apelles/inspector — an Inspector section, shared between `@apelles/motion`'s
 * `InspectorPanel.tsx` and `@apelles/editor`'s clip Inspector (D-103, Phase 4;
 * restyled and made collapsible by D-432 P4) — see this package's README.
 *
 * **Two modes, one component.**
 *
 *  - **Static** (no `onOpenChange`): a heading above its children, exactly the
 *    structure Motion's panels were built against — only the heading's type
 *    changed (title case, `--text-sm` 600, not 10 px uppercase tracked;
 *    ui-redesign defect 19). Motion keeps its own padded container.
 *  - **Collapsible** (`onOpenChange` given — `open` is controlled): the FCP /
 *    Resolve section. A 28 px header with a `CaretRight` / `CaretDown`, the
 *    title, an optional `meta` summary and right-hand `actions` (an enable
 *    checkbox, a reset), a 1 px divider under it, and a padded body. It is
 *    full-bleed — place it in a container with NO horizontal padding. A closed
 *    section **mounts no body** (lazy: a closed Highlights / EQ costs nothing).
 *
 * **What it does NOT do.** It does not remember anything: open state is the
 * caller's (`@apelles/editor` keeps it in `timelineStore.inspectorSections`
 * so it survives remounts and is readable by `debug_get_ui_state`). It has no
 * `@apelles/ui` dependency (Motion cannot import that barrel) and no rows —
 * `@apelles/ui`'s `InspectorRow` is the row grid.
 */
import type { ReactNode } from 'react';
import { CaretDownIcon, CaretRightIcon } from '@phosphor-icons/react';

export interface InspectorSectionProps {
  label: string;
  children: ReactNode;
  /** A stable id, surfaced as `data-chroma-section` for the debug DOM tools. */
  id?: string;
  /** Collapsible mode: whether the body is shown. Required with `onOpenChange`. */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** A short summary shown in the header (`0:12 in · 0:00 out`). */
  meta?: ReactNode;
  /** Right-hand header controls (outside the toggle button, so they nest no buttons). */
  actions?: ReactNode;
}

export function InspectorSection({ label, children, id, open, onOpenChange, meta, actions }: InspectorSectionProps) {
  if (!onOpenChange) {
    return (
      <div className="flex flex-col gap-2.5" data-chroma-section={id}>
        <h3 className="text-text-primary text-sm font-semibold">{label}</h3>
        {children}
      </div>
    );
  }

  const isOpen = open ?? true;
  const bodyId = id ? `inspector-section-${id}` : undefined;
  return (
    <section className="border-border-color border-b" data-chroma-section={id} data-open={isOpen ? '' : undefined}>
      <div className="flex h-7 items-center gap-1 pr-2 pl-2.5">
        <button
          type="button"
          className="hover:text-text-primary flex h-full min-w-0 flex-1 items-center gap-1.5 text-left"
          aria-expanded={isOpen}
          aria-controls={bodyId}
          onClick={() => onOpenChange(!isOpen)}
        >
          {isOpen ? (
            <CaretDownIcon size={10} className="text-text-secondary shrink-0" />
          ) : (
            <CaretRightIcon size={10} className="text-text-secondary shrink-0" />
          )}
          <span className="text-text-primary truncate text-sm font-semibold">{label}</span>
          {meta != null && <span className="text-text-secondary ml-auto truncate pl-2 font-mono text-xs">{meta}</span>}
        </button>
        {actions}
      </div>
      {isOpen && (
        <div id={bodyId} className="flex flex-col gap-0.5 px-3 pt-0.5 pb-2.5">
          {children}
        </div>
      )}
    </section>
  );
}
