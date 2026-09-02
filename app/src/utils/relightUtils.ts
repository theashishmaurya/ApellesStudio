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
const KIND_DEFAULTS: Record<RelightLight['kind'], Omit<RelightLight, 'id' | 'visible' | 'kind'>> = {
  key: { x: 25, y: 30, radius: 45, intensity: 110, color: '#fff4d6' }, // warm, screen-left
  fill: { x: 75, y: 55, radius: 55, intensity: 45, color: '#d6e8ff' }, // cool, low, wide, screen-right
  rim: { x: 50, y: 15, radius: 30, intensity: 90, color: '#ffffff' }, // top/behind, tight
  ambient: { x: 50, y: 50, radius: 100, intensity: 20, color: '#ffffff' }, // position/radius unused
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
