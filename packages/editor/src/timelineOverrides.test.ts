/**
 * @apelles/editor — the library overrides that carry real behaviour (D-432 P2).
 * jsdom applies no stylesheet, so these rules are pinned as text.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const css = readFileSync(new URL('./timeline-overrides.css', import.meta.url), 'utf8');

describe('timeline-overrides.css', () => {
  it('grabs the playhead by its head band only, not across every track (B-346)', () => {
    expect(css).toMatch(/\.timeline-editor-cursor-area\s*\{\s*height:\s*var\(--chroma-marker-strip-height/);
  });

  it('draws the playhead as a 1 px --color-playhead line on the named layer (§4.6)', () => {
    expect(css).toMatch(/\.timeline-editor-cursor\s*\{[^}]*width:\s*1px[^}]*background:\s*var\(--color-playhead\)[^}]*z-index:\s*var\(--z-timeline-playhead\)/);
  });

  it('drops the library`s grey clip backing and no longer styles its stretch triangles (§6 defects 6, 7)', () => {
    expect(css).toMatch(/\.timeline-editor-action\s*\{\s*background-color:\s*transparent/);
    expect(css).not.toMatch(/-stretch/);
  });
});
