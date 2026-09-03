// Chroma — interactive relight "Preset" tab (D-054, follow-up to D-048).
//
// D-048 shipped the Ambient / Light-N / +Add Light tabs but explicitly
// trimmed the ClipDrop reference strip's leading "Preset" tab (saved/built-in
// lighting setups) as UI polish, deferred to `docs/04-roadmap.md`. This is
// that follow-up.
//
// A preset is nothing more than a starting `RelightLight[]` — it populates
// `adjustments.relightLights` through the *exact same* `setAdjustments` path
// `RelightPanel`'s own "+Add Light" button uses (see `RelightPanel.tsx`'s
// `applyPreset`), not a separate code path. `createRelightLight` (below) is
// the same per-kind-defaults factory "+Add Light" calls; a preset just calls
// it more than once and overrides a few fields for a specific look.

import { RelightLight } from './adjustments';
import { createRelightLight } from './relightUtils';

export interface RelightPreset {
  id: string;
  label: string;
  /** One-line description shown under the label in the Preset tab. */
  description: string;
  /** Builds a fresh `RelightLight[]` (fresh ids every call) — REPLACES
   *  `adjustments.relightLights` when applied, the same way loading any
   *  other saved "look" would, not an append. */
  build: () => RelightLight[];
}

/** A deliberately small starter set, not an exhaustive gallery — three
 *  distinct, useful setups covering the common cases: a classic two-point
 *  portrait rig, a flat/flattering wash, and a moody single source. Each
 *  just patches `createRelightLight(kind)`'s own defaults; positions/radii
 *  are 0–100 frame percentages, matching every other light. */
export const RELIGHT_PRESETS: RelightPreset[] = [
  {
    id: 'warm-key-cool-rim',
    label: 'Warm key + cool rim',
    description: 'Warm key screen-left, cool rim from behind for edge separation.',
    build: () => [
      { ...createRelightLight('key'), x: 22, y: 32, radius: 42, intensity: 120, color: '#ffcf8a' },
      { ...createRelightLight('rim'), x: 78, y: 16, radius: 26, intensity: 95, color: '#9fd0ff' },
    ],
  },
  {
    id: 'soft-ambient-fill',
    label: 'Soft ambient fill',
    description: 'Gentle all-over lift plus a wide, low fill — flattering, low-contrast.',
    build: () => [
      { ...createRelightLight('ambient'), intensity: 25, color: '#fff6ea' },
      { ...createRelightLight('fill'), x: 65, y: 55, radius: 65, intensity: 55, color: '#f4ecff' },
    ],
  },
  {
    id: 'dramatic-single-source',
    label: 'Dramatic single-source',
    description: 'One strong, tightly-falling-off key light — moody, high-contrast.',
    build: () => [
      { ...createRelightLight('key'), x: 20, y: 25, radius: 28, intensity: 165, color: '#ffffff' },
    ],
  },
];
