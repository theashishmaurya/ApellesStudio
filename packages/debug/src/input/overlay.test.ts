// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';

import { findOverlays } from './overlay';

afterEach(() => {
  document.body.innerHTML = '';
});

/** jsdom lays nothing out: give an element a box and let the test decide what
 *  `elementFromPoint` answers. */
function box(el: Element, left: number, top: number, width: number, height: number) {
  el.getBoundingClientRect = () => ({ left, top, width, height, x: left, y: top, right: left + width, bottom: top + height, toJSON: () => ({}) });
}

function setup() {
  document.body.innerHTML = `
    <div id="part"><button id="inside"></button></div>
    <div id="dock" style="position: fixed"><span id="row"></span></div>
    <div id="plain"></div>`;
  const q = (id: string) => document.getElementById(id) as HTMLElement;
  box(q('part'), 0, 0, 100, 100);
  return q;
}

describe('findOverlays (H1)', () => {
  it('reports nothing when every sampled point lands on the part itself', () => {
    const q = setup();
    document.elementFromPoint = () => q('inside');
    expect(findOverlays(['#part'])).toEqual([]);
  });

  it('names the fixed overlay that covers points of the part', () => {
    const q = setup();
    document.elementFromPoint = (x: number) => (x < 50 ? q('row') : q('inside'));
    const hits = findOverlays(['#part']);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.every((h) => h.overlay?.startsWith('div#dock') && h.hit?.startsWith('span#row'))).toBe(true);
  });

  it('ignores a non-fixed element on top, and parts that are not on screen', () => {
    const q = setup();
    document.elementFromPoint = () => q('plain');
    expect(findOverlays(['#part', '#missing'])).toEqual([]);
  });
});
