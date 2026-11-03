/**
 * The v0.3.0 panel redesigns (D-441 Export, D-444 Music edits, D-445 Clipper;
 * `docs/notes/panel-redesign.md` "As built"), driven on the live app:
 * - Export: a preset chip selects (and is the summary's source), and a preset an
 *   agent saves through `editor_save_export_preset` appears in the open sheet at
 *   once — one preset table for the GUI and MCP;
 * - Music edits: the range is the timeline's In / Out marks (set by the MCP
 *   `editor_set_marks`, shown in the panel), and dragging the fade-out dot on
 *   the diagram lengthens the fade;
 * - Clipper: New shorts opens its form in the viewer area, and Esc gives the
 *   viewer back.
 *
 * What it does NOT do: export or apply anything on the owner's project (the
 * fixture is the harness's own), judge the look (the screenshot pass against
 * the mockup does), or review shorts from the keyboard — that needs an agent's
 * proposals, which a fixture cannot make; the DOM tests cover A / X / ↑ / ↓.
 */

import type { Scenario } from '../scenario.ts';
import { selector } from '../targets.ts';
import { THREE_CLIPS } from './common.ts';

const VERTICAL_CHIP = '[data-chroma-export-preset="vertical"]';
const SAVED_CHIP = '[data-chroma-export-preset="user:harness-review"]';
const FADE_OUT_DOT = '[data-chroma-music-fade-handle="out"]';

export const PANEL_SCENARIOS: Scenario[] = [
  {
    id: 'export-preset-chips',
    title: 'An Export preset chip selects; a preset an agent saves appears in the open sheet at once',
    area: 'export',
    reference: 'FCP Share destinations / Resolve Quick Export presets; the approved Export mockup (D-441)',
    fixture: THREE_CLIPS,
    steps: [
      { op: 'debug_set_popover_open', args: { id: 'export-dialog', open: true } },
      { wait: 400 },
      { reachable: { selector: '[data-chroma-export-sheet]', reason: 'the Export sheet opens from the top bar' } },
      { capture: 'dom', selector: '[data-chroma-export-dialog]', as: 'dialog' },
      {
        expect: [
          { path: 'dialog.rect.x', op: 'gte', value: 32, label: 'the sheet keeps its inset from the left edge (B-367 "over lapping")' },
          { path: 'dialog.rect.y', op: 'gte', value: 32, label: 'and from the top' },
        ],
      },
      { pointer: { action: 'click', target: selector(VERTICAL_CHIP) }, measure: true, label: 'pick Shorts · Reels · TikTok' },
      { capture: 'dom', selector: VERTICAL_CHIP, as: 'vertical' },
      { expect: { path: 'vertical.attrs.aria-checked', op: 'eq', value: 'true', label: 'the chip is selected' } },
      { op: 'editor_save_export_preset', args: { name: 'Harness review', width: 1280, height: 720, loudness: 'youtube' }, label: 'the AI half: save a preset' },
      { wait: 300 },
      { reachable: { selector: SAVED_CHIP, reason: 'a preset saved over MCP shows up as a chip in the open sheet (one table)' } },
      { op: 'editor_list_export_presets', as: 'listed' },
      { expect: { path: 'listed.presets.6.id', op: 'eq', value: 'user:harness-review', label: 'and in the MCP list, after the six built-ins' } },
      { op: 'editor_save_export_preset', args: { name: 'Harness review', delete: true }, label: 'clean up the saved preset' },
      { op: 'debug_set_popover_open', args: { id: 'export-dialog', open: false } },
    ],
  },
  {
    id: 'music-fade-dot-drag',
    title: 'Music edits takes its range from the In / Out marks, and dragging the fade-out dot lengthens the fade',
    area: 'music-edits',
    reference: 'Resolve Fairlight fade handles; the approved Music edits mockup, revision 2 ("fades are dragged on the diagram\'s dots", D-444)',
    fixture: THREE_CLIPS,
    steps: [
      { op: 'debug_set_library_mode', args: { mode: 'music' } },
      { op: 'editor_set_marks', args: { inPoint: 30, outPoint: 60 }, label: 'the range, set by the MCP marks tool' },
      { wait: 300 },
      { reachable: { selector: '[data-chroma-music-edits-maker]', reason: 'marked In / Out opens the maker with that range' } },
      { capture: 'dom', selector: FADE_OUT_DOT, as: 'before' },
      {
        pointer: {
          action: 'drag',
          target: selector(FADE_OUT_DOT, { fx: 0.5, fy: 0.5 }),
          to: selector(FADE_OUT_DOT, { fx: 0.5, fy: 0.5, dx: -40 }),
          steps: 8,
          durationMs: 300,
        },
        measure: true,
        label: 'drag the fade-out dot 40 px left',
      },
      { capture: 'dom', selector: FADE_OUT_DOT, as: 'after' },
      { expect: { path: 'after.attrs.aria-valuenow', op: 'changed', from: 'before', label: 'the fade length changed' } },
      { op: 'editor_set_marks', args: { inPoint: null, outPoint: null }, label: 'clear the marks' },
    ],
  },
  {
    id: 'clipper-surface-open-close',
    title: 'New shorts opens its form in the viewer area; Esc gives the viewer back',
    area: 'clipper',
    reference: 'Opus Clip / Descript review surfaces; owner decision 2026-11-03: the Clipper review lives in the viewer area (D-445)',
    fixture: THREE_CLIPS,
    steps: [
      { op: 'debug_set_library_mode', args: { mode: 'clipper' } },
      { wait: 300 },
      { reachable: { selector: '[data-chroma-clipper-new]', reason: 'the Shorts tab offers New shorts' } },
      { pointer: { action: 'click', target: selector('[data-chroma-clipper-new]') }, measure: true, label: 'New shorts' },
      { reachable: { selector: '[data-chroma-panel="edit-viewer"] [data-chroma-clipper-surface="setup"]', reason: 'the form fills the viewer area, not the 280 px column' } },
      { key: { keys: ['Escape'] }, label: 'Esc' },
      { wait: 200 },
      { capture: 'dom', selector: '[data-chroma-clipper-surface]', as: 'gone' },
      { expect: { path: 'gone.rect', op: 'falsy', label: 'the surface closed; the viewer is back' } },
      { op: 'debug_set_library_mode', args: { mode: 'sources' } },
    ],
  },
];
