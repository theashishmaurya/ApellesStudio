/**
 * @chroma/inspector — a section heading, shared between `@chroma/motion`'s
 * `InspectorPanel.tsx` and `@chroma/editor`'s `ClipInspectorPanel.tsx`
 * (D-103, Phase 4) — see this package's README. Both panels had converged
 * on the identical uppercase/tracking-wide treatment independently; this is
 * that treatment, factored out rather than left to drift.
 */
import type { ReactNode } from 'react';

export function InspectorSection({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-2.5">
      <h3 className="text-[10px] font-semibold uppercase tracking-wide text-text-secondary/70">{label}</h3>
      {children}
    </div>
  );
}
