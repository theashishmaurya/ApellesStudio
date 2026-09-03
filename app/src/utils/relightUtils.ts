// Interactive relight (D-046) — factory + small pure helpers for the
// `RelightLight` list on `adjustments.relightLights`. Mirrors `maskUtils.ts`'s
// `createSubMask` convention (a plain factory, no store access) rather than
// inventing a different shape for this one layer type.

import { v4 as uuidv4 } from 'uuid';
import { RelightLight } from './adjustments';

/** Per-kind starting position/color/intensity — a ClipDrop-Relight-style
 *  "Add Light" gives you something reasonable pointed at the frame, not a
 *  light stacked dead-center at full strength. Position is expressed as a
 *  0–100 percentage of the frame, matching every other shape-mask geometry
 *  field already in this codebase. */
// `distance` (D-076) defaults to nonzero on purpose — a light dropped at
// distance 0 sits flush on the surface and shades almost nothing (see
// `RelightLight.distance`'s doc comment); a fresh "Add Light" needs to look
// lit immediately, not require the user to discover a slider first.
const KIND_DEFAULTS: Record<RelightLight['kind'], Omit<RelightLight, 'id' | 'visible' | 'kind'>> = {
  key: { x: 25, y: 30, radius: 45, distance: 40, intensity: 110, color: '#fff4d6' }, // warm, screen-left
  fill: { x: 75, y: 55, radius: 55, distance: 40, intensity: 45, color: '#d6e8ff' }, // cool, low, wide, screen-right
  rim: { x: 50, y: 15, radius: 30, distance: 55, intensity: 90, color: '#ffffff' }, // top/behind, tight
  ambient: { x: 50, y: 50, radius: 100, distance: 40, intensity: 20, color: '#ffffff' }, // position/radius/distance unused
};

/** A new light of `kind`, positioned + coloured per its preset default. */
export function createRelightLight(kind: RelightLight['kind']): RelightLight {
  return {
    id: uuidv4(),
    kind,
    visible: true,
    ...KIND_DEFAULTS[kind],
  };
}

/** Display label for a light's kind — "Light N" for key/fill/rim (numbered by
 *  their position among lights of that same non-ambient kind), "Ambient" for
 *  the ambient light. Matches the ClipDrop-style bottom tab strip
 *  (Preset / Ambient / Light 1 / Light 2 / + Add Light) named in D-046. */
export function relightLightLabel(light: RelightLight, allLights: RelightLight[]): string {
  if (light.kind === 'ambient') return 'Ambient';
  const positionalLights = allLights.filter((l) => l.kind !== 'ambient');
  const index = positionalLights.findIndex((l) => l.id === light.id);
  return `Light ${index === -1 ? positionalLights.length + 1 : index + 1}`;
}
