/**
 * @apelles/inspector — the "nothing selected" message, shared between
 * `@apelles/motion`'s `InspectorPanel.tsx` and `@apelles/editor`'s
 * `ClipInspectorPanel.tsx` (D-103, Phase 4) — see this package's README for
 * why this is a separate package rather than living in `@apelles/ui`.
 *
 * v0.3.0 (D-432 §4.13) — restyled to the type scale (`text-xs`
 * `text-secondary`) with an optional Phosphor glyph above the line.
 */
import type { ReactNode } from 'react';

export function InspectorEmptyState({ children, icon }: { children: ReactNode; icon?: ReactNode }) {
  return (
    <div
      data-chroma-empty-state="inspector"
      className="flex h-full w-full flex-col items-center justify-center gap-2 px-4 text-center text-xs text-text-secondary"
    >
      {icon && <span className="text-text-tertiary [&_svg]:size-6">{icon}</span>}
      <span>{children}</span>
    </div>
  );
}
