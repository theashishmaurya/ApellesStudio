/** D-434 — target resolution: selector / test id / node id → a point, with what is really under it. */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { nodeIdOf } from '../domTree';
import { describeElement, isTargetError, resolveTarget, type ResolvedTarget } from './geometry';

function rect(el: Element, x: number, y: number, width: number, height: number) {
  el.getBoundingClientRect = () =>
    ({ x, y, left: x, top: y, width, height, right: x + width, bottom: y + height, toJSON: () => ({}) }) as DOMRect;
}

function ok(v: ReturnType<typeof resolveTarget>): ResolvedTarget {
  if (isTargetError(v)) throw new Error(v.error);
  return v;
}

let overlay: HTMLElement;
let clip: HTMLElement;

beforeEach(() => {
  document.body.innerHTML = `
    <div id="area">
      <div data-testid="timeline-clip" data-chroma-clip-id="a" class="clip"></div>
      <div data-testid="timeline-clip" data-chroma-clip-id="b" class="clip"><span class="label">B</span></div>
      <div id="overlay"></div>
      <div data-testid="hidden"></div>
    </div>`;
  const clips = document.querySelectorAll('[data-testid="timeline-clip"]');
  rect(clips[0], 100, 50, 200, 40);
  rect(clips[1], 320, 50, 100, 40);
  clip = clips[1] as HTMLElement;
  overlay = document.getElementById('overlay') as HTMLElement;
  rect(document.querySelector('[data-testid="hidden"]') as Element, 0, 0, 0, 0);
  // jsdom has no layout: say what is under each point the way a browser would.
  document.elementFromPoint = (x: number) => (x >= 320 ? (clip.firstElementChild as Element) : overlay);
});

afterEach(() => {
  document.body.innerHTML = '';
});

describe('resolveTarget', () => {
  it('a test id resolves to the centre of the first match, and reports the match count', () => {
    const t = ok(resolveTarget({ testid: 'timeline-clip' }));
    expect({ x: t.x, y: t.y, matched: t.matched }).toEqual({ x: 200, y: 70, matched: 2 });
    expect(t.rect).toEqual({ x: 100, y: 50, width: 200, height: 40 });
  });

  it('reports what is REALLY under the point, so an overlay eating the press is visible', () => {
    const t = ok(resolveTarget({ testid: 'timeline-clip' }));
    expect(t.hit).toBe('div#overlay');
    expect(t.hitInside).toBe(false);
  });

  it('a hit on a descendant counts as inside the target', () => {
    const t = ok(resolveTarget({ selector: '[data-chroma-clip-id="b"]' }));
    expect(t.hitInside).toBe(true);
    expect(t.hit).toBe('span.label');
  });

  it('`at` places the point by fraction and offset — an edge-trim zone without hard-coded pixels', () => {
    const t = ok(resolveTarget({ testid: 'timeline-clip', at: { fx: 1, dx: -3, fy: 0.5 } }));
    expect({ x: t.x, y: t.y }).toEqual({ x: 297, y: 70 });
  });

  it('nth picks a later match, negative counts from the end', () => {
    expect(ok(resolveTarget({ testid: 'timeline-clip', nth: 1 })).x).toBe(370);
    expect(ok(resolveTarget({ testid: 'timeline-clip', nth: -1 })).x).toBe(370);
    expect(isTargetError(resolveTarget({ testid: 'timeline-clip', nth: 2 }))).toBe(true);
  });

  it('a debug_dom_tree node id names the same element', () => {
    const id = nodeIdOf(clip);
    const t = ok(resolveTarget({ nodeId: id }));
    expect(t.element).toBe(describeElement(clip));
  });

  it('refuses what cannot be pressed: no match, no box, off-screen, ambiguous naming, bad selector', () => {
    expect(resolveTarget({ testid: 'nope' })).toEqual({ error: 'no element matches [data-testid="nope"]' });
    expect((resolveTarget({ testid: 'hidden' }) as { error: string }).error).toMatch(/no box/);
    expect((resolveTarget({ testid: 'timeline-clip', at: { dx: 5000 } }) as { error: string }).error).toMatch(/outside/);
    expect((resolveTarget({ testid: 'a', selector: 'b' }) as { error: string }).error).toMatch(/exactly one/);
    expect((resolveTarget({ selector: '<<<' }) as { error: string }).error).toMatch(/invalid selector/);
    expect((resolveTarget({ nodeId: '9.9.9' }) as { error: string }).error).toMatch(/DOM changed/);
  });

  it('a raw point is checked against the viewport and still reports its hit', () => {
    const t = ok(resolveTarget({ x: 400, y: 10 }));
    expect(t.hit).toBe('span.label');
    expect(t.hitInside).toBeNull();
    expect(isTargetError(resolveTarget({ x: -1, y: 0 }))).toBe(true);
  });
});
