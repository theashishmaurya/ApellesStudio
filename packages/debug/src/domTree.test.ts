/**
 * domTree.test.ts (D-218) — the DOM serialiser's contract.
 *
 * What these cover: the parts with correct answers — the three bounds
 * (`selector` / `maxDepth` / `maxNodes`) and that each one REPORTS itself
 * when it bites, which attributes/styles come through, own-text vs. subtree
 * text, and dialog detection. The point of the bounds is that a caller can
 * tell "300 nodes" from "300 nodes and there were more", so every truncation
 * assertion checks the flag as well as the shape.
 *
 * jsdom lays nothing out, so every `getBoundingClientRect()` here is 0×0 —
 * the rects are checked for SHAPE, and the real numbers are checked live
 * against the running app (see `docs/notes/debug-tooling.md`).
 */
import { beforeEach, describe, expect, it } from 'vitest';

import {
  DEFAULT_MAX_NODES,
  MAX_CLASSES,
  MAX_TEXT_CHARS,
  cssPropName,
  describeOpenDialogs,
  serializeDomTree,
} from './domTree';

function setBody(html: string): void {
  document.body.innerHTML = html;
}

beforeEach(() => {
  document.body.innerHTML = '';
});

describe('serializeDomTree', () => {
  it('defaults to body and reports the hierarchy in document order', () => {
    setBody('<div id="a"><span>one</span><span>two</span></div>');
    const tree = serializeDomTree();

    expect(tree.selector).toBe('body');
    expect(tree.root?.tag).toBe('body');
    expect(tree.root?.children?.[0].id).toBe('a');
    expect(tree.root?.children?.[0].children?.map((c) => c.text)).toEqual(['one', 'two']);
    expect(tree.truncated).toBe(false);
    // body + div + 2 spans
    expect(tree.nodeCount).toBe(4);
  });

  it('roots at an arbitrary selector', () => {
    setBody('<div class="wrap"><section data-chroma-panel="editor-inspector"><b>x</b></section></div>');
    const tree = serializeDomTree({ selector: '[data-chroma-panel="editor-inspector"]' });

    expect(tree.root?.tag).toBe('section');
    expect(tree.root?.attrs?.['data-chroma-panel']).toBe('editor-inspector');
    expect(tree.nodeCount).toBe(2);
  });

  it('returns a null root — not an error — when nothing matches', () => {
    setBody('<div></div>');
    const tree = serializeDomTree({ selector: '#nope' });

    expect(tree.root).toBeNull();
    expect(tree.nodeCount).toBe(0);
  });

  it('lets an invalid selector throw, so it can be told apart from no match', () => {
    expect(() => serializeDomTree({ selector: '<<<' })).toThrow();
  });

  it('stops at maxDepth and says so', () => {
    setBody('<div><div><div><div><b>deep</b></div></div></div></div>');
    const tree = serializeDomTree({ maxDepth: 2 });

    const level2 = tree.root?.children?.[0].children?.[0];
    expect(level2?.children).toBeUndefined();
    expect(level2?.childrenTruncated).toBe('depth');
    expect(tree.truncated).toBe(true);
    expect(tree.maxDepth).toBe(2);
  });

  it('stops at maxNodes and says so', () => {
    setBody(`<div>${'<span></span>'.repeat(50)}</div>`);
    const tree = serializeDomTree({ maxNodes: 5 });

    expect(tree.nodeCount).toBe(5);
    expect(tree.truncated).toBe(true);
    expect(tree.root?.children?.[0].childrenTruncated).toBe('nodes');
  });

  it('clamps a nonsense bound back to the default rather than refusing', () => {
    setBody('<div></div>');
    expect(serializeDomTree({ maxNodes: 'lots' as unknown as number }).maxNodes).toBe(DEFAULT_MAX_NODES);
    expect(serializeDomTree({ maxNodes: -3 }).maxNodes).toBe(1);
  });

  it('keeps id, classes, data-* and aria-* but drops class/style duplication', () => {
    setBody('<button id="go" class="a b" data-x="1" aria-pressed="true" style="color:red">Go</button>');
    const node = serializeDomTree({ selector: '#go' }).root;

    expect(node?.id).toBe('go');
    expect(node?.classes).toEqual(['a', 'b']);
    expect(node?.attrs).toEqual({ 'data-x': '1', 'aria-pressed': 'true' });
    expect(node?.attrs?.style).toBeUndefined();
    expect(node?.attrs?.class).toBeUndefined();
  });

  it('caps a Tailwind-sized class list and flags it', () => {
    const classes = Array.from({ length: MAX_CLASSES + 5 }, (_, i) => `c${i}`).join(' ');
    setBody(`<div id="t" class="${classes}"></div>`);
    const node = serializeDomTree({ selector: '#t' }).root;

    expect(node?.classes).toHaveLength(MAX_CLASSES);
    expect(node?.classesTruncated).toBe(true);
  });

  it("reports an element's OWN text, not its subtree's, and truncates it", () => {
    setBody('<div id="t">mine<span>theirs</span></div>');
    expect(serializeDomTree({ selector: '#t' }).root?.text).toBe('mine');

    setBody(`<div id="long">${'x'.repeat(MAX_TEXT_CHARS + 20)}</div>`);
    const text = serializeDomTree({ selector: '#long' }).root?.text ?? '';
    expect(text).toHaveLength(MAX_TEXT_CHARS + 1); // + the ellipsis
    expect(text.endsWith('…')).toBe(true);
  });

  it('omits text entirely when asked to', () => {
    setBody('<div id="t">mine</div>');
    expect(serializeDomTree({ selector: '#t', text: false }).root?.text).toBeUndefined();
  });

  it('reports only the requested computed styles, under their kebab-case names', () => {
    setBody('<div id="t" style="position:absolute"></div>');
    const node = serializeDomTree({ selector: '#t', styles: ['position', 'zIndex'] }).root;

    expect(node?.styles?.position).toBe('absolute');
    expect(node?.styles?.['z-index']).toBeDefined();
    expect(node?.styles?.zIndex).toBeUndefined();
    expect(node?.styles?.display).toBeUndefined();
  });

  it('reports no styles when the caller asks for none', () => {
    setBody('<div id="t"></div>');
    expect(serializeDomTree({ selector: '#t', styles: [] }).root?.styles).toBeUndefined();
  });

  it('flags a zero-area box but still walks into it', () => {
    // jsdom lays nothing out, so every element here is 0×0 — which is exactly
    // the case this guards: a zero-size PARENT whose children still render is
    // a real layout bug, so it must never be a reason to prune.
    setBody('<div id="t"><span>still here</span></div>');
    const node = serializeDomTree({ selector: '#t' }).root;

    expect(node?.zeroArea).toBe(true);
    expect(node?.invisible).toBeUndefined();
    expect(node?.children?.[0].text).toBe('still here');
  });

  it('flags a display:none element and skips its subtree unless asked', () => {
    setBody('<div id="t" style="display:none"><span>hidden child</span></div>');

    const skipped = serializeDomTree({ selector: '#t' });
    expect(skipped.root?.invisible).toBe(true);
    expect(skipped.root?.children).toBeUndefined();
    expect(skipped.root?.childrenTruncated).toBe('invisible');
    expect(skipped.truncated).toBe(true);

    const included = serializeDomTree({ selector: '#t', includeHidden: true });
    expect(included.root?.children?.[0].text).toBe('hidden child');
  });

  it('carries the viewport so a CSS rect can be mapped onto a screenshot', () => {
    const tree = serializeDomTree();
    expect(typeof tree.viewport.width).toBe('number');
    expect(typeof tree.viewport.devicePixelRatio).toBe('number');
  });
});

describe('cssPropName', () => {
  it('normalises camelCase to the kebab form getPropertyValue understands', () => {
    expect(cssPropName('backgroundColor')).toBe('background-color');
    expect(cssPropName('z-index')).toBe('z-index');
  });
});

describe('describeOpenDialogs', () => {
  it('finds dialogs by role rather than by any store flag', () => {
    setBody(`
      <div role="dialog" aria-label="Export"></div>
      <div role="alertdialog" aria-labelledby="t"><h2 id="t">Delete project?</h2></div>
      <div role="button"></div>
    `);
    const dialogs = describeOpenDialogs();

    expect(dialogs).toHaveLength(2);
    expect(dialogs[0].label).toBe('Export');
    expect(dialogs[1].role).toBe('alertdialog');
    expect(dialogs[1].label).toBe('Delete project?');
  });

  it('ignores a dialog that is not actually showing', () => {
    setBody('<div role="dialog" style="display:none" aria-label="Closed"></div>');
    expect(describeOpenDialogs()).toEqual([]);
  });

  it('reports nothing on a page with no modal open', () => {
    setBody('<main><p>no modals here</p></main>');
    expect(describeOpenDialogs()).toEqual([]);
  });
});
