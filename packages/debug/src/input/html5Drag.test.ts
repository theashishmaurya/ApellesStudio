// @vitest-environment jsdom
/**
 * `debug_pointer`'s `html5Drag` (B-360): the page's own dragstart / dragover /
 * drop handlers run with one shared transfer, and a drop happens only when the
 * final dragover was accepted, as in a browser. jsdom lays nothing out, so
 * `elementFromPoint` is stubbed to say which element sits at each x.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { runHtml5Drag } from './html5Drag';

const MIME = 'application/x-test-media';
let source: HTMLDivElement;
let zone: HTMLDivElement;
let restore: () => void;
let dropped: string[];

beforeEach(() => {
  dropped = [];
  source = document.createElement('div');
  source.setAttribute('draggable', 'true');
  source.addEventListener('dragstart', (e) => (e as DragEvent).dataTransfer?.setData(MIME, '{"id":"m1"}'));
  zone = document.createElement('div');
  zone.addEventListener('dragover', (e) => {
    if ((e as DragEvent).dataTransfer?.types.includes(MIME)) e.preventDefault();
  });
  zone.addEventListener('drop', (e) => dropped.push((e as DragEvent).dataTransfer?.getData(MIME) ?? ''));
  document.body.append(source, zone);
  const original = document.elementFromPoint;
  // x < 100: the source; x >= 100: the drop zone.
  document.elementFromPoint = (x: number) => (x < 100 ? source : zone);
  restore = () => {
    document.elementFromPoint = original;
  };
});

afterEach(() => {
  restore();
  source.remove();
  zone.remove();
});

describe('runHtml5Drag', () => {
  it('carries the dragstart payload to the drop target through one transfer', async () => {
    const r = await runHtml5Drag([{ x: 10, y: 10 }, { x: 300, y: 10 }], 3);
    expect('error' in r).toBe(false);
    if ('error' in r) return;
    expect(r.dataTypes).toEqual([MIME]);
    expect(r.dropAccepted).toBe(true);
    expect(r.dropped).toBe(true);
    expect(r.trusted).toBe(false);
    expect(dropped).toEqual(['{"id":"m1"}']);
  });

  it('does not drop when the target never accepts the dragover', async () => {
    const r = await runHtml5Drag([{ x: 10, y: 10 }, { x: 50, y: 10 }], 3);
    if ('error' in r) throw new Error(r.error);
    expect(r.dropAccepted).toBe(false);
    expect(r.dropped).toBe(false);
    expect(dropped).toEqual([]);
  });

  it('refuses when nothing draggable is under the start point', async () => {
    document.elementFromPoint = () => zone;
    const r = await runHtml5Drag([{ x: 10, y: 10 }, { x: 300, y: 10 }]);
    expect('error' in r && r.error).toMatch(/nothing draggable/);
  });

  it('needs a start and an end point', async () => {
    const r = await runHtml5Drag([{ x: 10, y: 10 }]);
    expect('error' in r && r.error).toMatch(/needs a 'target'/);
  });
});
