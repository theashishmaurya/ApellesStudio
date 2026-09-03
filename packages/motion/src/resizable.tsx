/**
 * @chroma/motion — a tiny local resizable-panel wrapper (D-099).
 *
 * Not `@chroma/ui`'s `ResizablePanelGroup`/`ResizablePanel`/`ResizableHandle`:
 * that package's barrel also exports `Text`, whose polymorphic `as`-prop
 * typing breaks once `@react-three/fiber`'s global `JSX.IntrinsicElements`
 * augmentation — pulled in transitively via `@chroma/motion-engine`'s
 * `Scene3D`/`ParticleFlow` — sits in the same `tsc` program (see `Button.tsx`'s
 * doc comment; a pre-existing `@chroma/ui` fragility, not this tab's bug).
 * `@chroma/ui`'s own `resizable.tsx` is itself just a thin styled wrapper
 * around `react-resizable-panels` (confirmed by reading it, not assumed) —
 * this mirrors that exact wrapper directly against the same underlying
 * library, so the CLAUDE.md "every resizable-by-nature pane must actually be
 * resizable" rule is honoured with the real engine, without importing the
 * broken-for-this-package barrel.
 */
import { Group, Panel, Separator, type GroupProps, type PanelProps, type SeparatorProps } from 'react-resizable-panels';

export function PanelGroup({ className, ...props }: GroupProps) {
  return (
    <Group
      className={['flex h-full w-full aria-[orientation=vertical]:flex-col', className].filter(Boolean).join(' ')}
      {...props}
    />
  );
}

export function ResizablePanel(props: PanelProps) {
  return <Panel {...props} />;
}

export function ResizableHandle({ className, ...props }: SeparatorProps) {
  return (
    <Separator
      className={[
        'relative w-px shrink-0 bg-border-color hover:bg-accent/60 transition-colors',
        'aria-[orientation=horizontal]:h-px aria-[orientation=horizontal]:w-full',
        'focus-visible:outline-none focus-visible:bg-accent',
        className,
      ]
        .filter(Boolean)
        .join(' ')}
      {...props}
    />
  );
}
