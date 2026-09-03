/**
 * @chroma/inspector — the "nothing selected" message, shared between
 * `@chroma/motion`'s `InspectorPanel.tsx` and `@chroma/editor`'s
 * `ClipInspectorPanel.tsx` (D-103, Phase 4) — see this package's README for
 * why this is a separate package rather than living in `@chroma/ui`.
 */
import type { ReactNode } from 'react';

export function InspectorEmptyState({ children }: { children: ReactNode }) {
  return (
    <div className="h-full w-full flex items-center justify-center text-[11px] text-text-secondary/60 px-4 text-center">
      {children}
    </div>
  );
}
