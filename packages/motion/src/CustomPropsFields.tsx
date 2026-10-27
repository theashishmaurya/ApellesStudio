/**
 * @apelles/motion — the Inspector's fields for a custom component layer
 * (D-409).
 *
 * What it is: one control per prop the layer's component declares, read from
 * the definition the document embeds (`manifest.components["<id>@<v>"]`) and
 * built from the Inspector's own `FieldControl` (the same controls a template
 * slot gets). An edit writes the layer's whole `props` object back through
 * `setLayerField`, so it is one undoable edit and passes the same manifest
 * check every other edit does (a value outside a prop's constraints is refused
 * by the commit guard with the issue).
 *
 * What it does NOT do: show or edit the component's code (the Catalog's
 * read-only source view), or keyframe props (the layer's Property tracks field
 * does that, `anim: {"props.<id>": [...]}`).
 */
import type { Manifest } from '@apelles/motion-engine/src/engine/schema';
import type { TemplateSlot } from '@apelles/motion-engine/src/slots';
import { InspectorSection } from '@apelles/inspector';
import { FieldControl } from './InspectorPanel';
import { ListSlotControl, specForSlot } from './TemplatesSection';

export function CustomPropsFields({
  manifest,
  raw,
  onCommit,
}: {
  manifest: Manifest;
  raw: Record<string, unknown>;
  onCommit: (props: Record<string, unknown> | undefined) => void;
}) {
  const ref = typeof raw.component === 'string' ? raw.component : '';
  const def = manifest.components?.[ref];
  const props = raw.props && typeof raw.props === 'object' ? (raw.props as Record<string, unknown>) : {};
  if (!def) return null;
  const set = (id: string, v: unknown) => {
    const next = { ...props };
    if (v === undefined || v === null || v === '') delete next[id];
    else next[id] = v;
    onCommit(Object.keys(next).length > 0 ? next : undefined);
  };
  return (
    <InspectorSection label={`${def.name} · ${ref}`}>
      {def.props.length === 0 && <p className="text-[10px] text-text-secondary">This component declares no props.</p>}
      {def.props.map((slot: TemplateSlot) => (
        <div key={slot.id} className="flex flex-col gap-0.5">
          {slot.type === 'list' ? (
            <ListSlotControl slot={slot} value={props[slot.id] ?? slot.default} onCommit={(v) => set(slot.id, v)} />
          ) : (
            <FieldControl spec={specForSlot(slot)} value={props[slot.id] ?? slot.default} onCommit={(v) => set(slot.id, v)} />
          )}
          {slot.type === 'color' && props[slot.id] === undefined && (
            <span className="text-[9px] text-text-secondary/70">unset: follows the theme</span>
          )}
        </div>
      ))}
    </InspectorSection>
  );
}
