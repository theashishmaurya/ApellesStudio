'use client';

import { Collapsible as CollapsiblePrimitive } from '@base-ui/react/collapsible';

/**
 * shadcn `collapsible` on the Base UI `Collapsible` primitive (D-042).
 * Base UI exposes the panel as `Collapsible.Panel`; the shadcn names are kept.
 */
function Collapsible({ ...props }: CollapsiblePrimitive.Root.Props) {
  return <CollapsiblePrimitive.Root data-slot="collapsible" {...props} />;
}

function CollapsibleTrigger({ ...props }: CollapsiblePrimitive.Trigger.Props) {
  return <CollapsiblePrimitive.Trigger data-slot="collapsible-trigger" {...props} />;
}

function CollapsibleContent({ ...props }: CollapsiblePrimitive.Panel.Props) {
  return <CollapsiblePrimitive.Panel data-slot="collapsible-content" {...props} />;
}

export { Collapsible, CollapsibleTrigger, CollapsibleContent };
