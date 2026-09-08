'use client';

import { Tabs as TabsPrimitive } from '@base-ui/react/tabs';
import { cva, type VariantProps } from 'class-variance-authority';

import { cn } from '../../lib/utils';

/** shadcn `tabs` on Base UI (D-042). Base UI: Root / List / Tab / Panel. */
function Tabs({ className, orientation = 'horizontal', ...props }: TabsPrimitive.Root.Props) {
  return (
    <TabsPrimitive.Root
      data-slot="tabs"
      data-orientation={orientation}
      className={cn('group/tabs flex gap-2 data-horizontal:flex-col', className)}
      {...props}
    />
  );
}

const tabsListVariants = cva(
  'group/tabs-list inline-flex w-fit items-center justify-center rounded-lg p-[3px] text-muted-foreground group-data-vertical/tabs:h-fit group-data-vertical/tabs:flex-col',
  {
    variants: {
      variant: {
        default: 'bg-muted',
        line: 'gap-1 bg-transparent',
      },
    },
    defaultVariants: { variant: 'default' },
  },
);

function TabsList({
  className,
  variant = 'default',
  ...props
}: TabsPrimitive.List.Props & VariantProps<typeof tabsListVariants>) {
  return (
    <TabsPrimitive.List
      data-slot="tabs-list"
      data-variant={variant}
      className={cn(tabsListVariants({ variant }), className)}
      {...props}
    />
  );
}

function TabsTrigger({ className, ...props }: TabsPrimitive.Tab.Props) {
  return (
    <TabsPrimitive.Tab
      data-slot="tabs-trigger"
      className={cn(
        'relative inline-flex h-[calc(100%-1px)] flex-1 items-center justify-center gap-1.5 rounded-md border border-transparent px-2 py-1 text-sm font-medium whitespace-nowrap text-foreground/60 transition-all',
        'group-data-vertical/tabs:w-full group-data-vertical/tabs:justify-start',
        'hover:text-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-1 focus-visible:outline-ring',
        'disabled:pointer-events-none disabled:opacity-50 aria-disabled:pointer-events-none aria-disabled:opacity-50',
        // B-124 — `data-active`, NOT `data-selected`. Base UI's `Tabs.Tab`
        // emits `data-active` on the selected tab (`TabsTabDataAttributes`:
        // activationDirection / orientation / disabled / active — there is no
        // `selected`), so the `data-selected:` variants these three lines
        // carried from the shadcn-for-Radix source matched nothing and the
        // selected tab was styled exactly like an unselected one: no
        // background, no shadow, same 60%-opacity label. Dead since D-042,
        // and the reason D-246's Video/Audio bar read as "not our design
        // system" — it had no selected state at all to read.
        'data-active:bg-background data-active:text-foreground data-active:shadow-sm',
        'group-data-[variant=line]/tabs-list:data-active:bg-transparent group-data-[variant=line]/tabs-list:data-active:shadow-none',
        "[&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
        className,
      )}
      {...props}
    />
  );
}

/** B-124 — the two rules that make a deselected panel actually STOP PAINTING,
 *  independently of whether Base UI ever gets to unmount it.
 *
 *  Base UI hides an inactive panel by unmounting it, and that unmount is
 *  gated on `useOpenChangeComplete` → `useAnimationsFinished`, which waits on
 *  a `requestAnimationFrame` callback before it even looks at
 *  `getAnimations()`. A webview whose rAF is not ticking therefore never
 *  clears `mounted`, so the panel keeps its box forever — and it does not
 *  even carry `hidden` while stuck, because `hidden` is `!mounted`. That is
 *  not hypothetical: this app's own `previewTiming.ts` documents that "a
 *  background window's `requestAnimationFrame` is throttled to a stop", which
 *  is every agent-driven session, and it is exactly how D-246's Video/Audio
 *  tabs came to render BOTH panels stacked (see B-124 in `docs/BUGS.md`).
 *
 *  - `[&[inert]]:hidden` is the load-bearing one. `inert` is written straight
 *    from `open` on every render (`inert: inertValue(!open)` in Base UI's own
 *    `TabsPanel`), with no effect, no frame and no animation in between, so it
 *    is correct on the very same commit the value changes — the deselected
 *    panel is the inert one, by construction.
 *  - `[&[hidden]]:hidden` covers the healthy path's own footgun: `[hidden]`
 *    is a UA-stylesheet rule, and ANY author-origin `display` utility (this
 *    panel's own `flex-1`, or a `flex` from a call site) beats it on origin
 *    alone, so a `hidden` panel would still paint. As an author rule at
 *    class+attribute specificity, this wins over both.
 *
 *  Neither costs anything on the healthy path: the panel is unmounted there
 *  and matches no selector at all. */
const TABS_CONTENT_HIDDEN = '[&[inert]]:hidden [&[hidden]]:hidden';

function TabsContent({ className, ...props }: TabsPrimitive.Panel.Props) {
  return (
    <TabsPrimitive.Panel
      data-slot="tabs-content"
      className={cn('flex-1 outline-none', TABS_CONTENT_HIDDEN, className)}
      {...props}
    />
  );
}

export { Tabs, TabsList, TabsTrigger, TabsContent, tabsListVariants };
