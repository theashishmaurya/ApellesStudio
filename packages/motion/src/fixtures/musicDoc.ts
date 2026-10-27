/**
 * D-413 — test fixtures for the soundtrack features: a 120 BPM beat analysis
 * and a two-scene document with a soundtrack, keyed layers, an anim track and
 * a camera. Shared by `musicTiming.test.ts` and `musicOps.e2e.test.ts`.
 */
import type { BeatAnalysis } from '@apelles/beats';
import { manifestSchema, type Manifest } from '@apelles/motion-engine/src/engine/schema';

/** 120 BPM from 0 s: a downbeat every 2 s, beat 3 of each bar strong too. */
export function beatsFixture(count = 40): BeatAnalysis {
  return {
    algorithmVersion: 1,
    duration: count * 0.5,
    tempoBpm: 120,
    meter: 4,
    beats: Array.from({ length: count }, (_, i) => ({
      time: i * 0.5,
      bar: Math.floor(i / 4) + 1,
      beat: (i % 4) + 1,
      downbeat: i % 4 === 0,
      strength: i % 4 === 0 ? 1 : i % 4 === 2 ? 0.8 : 0.3,
      strong: i % 4 === 0 || i % 4 === 2,
    })),
  };
}

const HASH = 'a'.repeat(64);

export function musicDoc(offset = 0): Manifest {
  return manifestSchema.parse({
    title: 'music',
    width: 1280,
    height: 720,
    fps: 30,
    soundtrack: { src: `sha256:${HASH}.mp3`, offset },
    scenes: [
      {
        id: 'intro',
        dur: 4,
        camera: [{ at: 0.1, zoom: 1 }, { at: 3.1, zoom: 1.2 }],
        layers: [
          {
            use: 'shape',
            id: 'hero',
            shape: 'ellipse',
            x: 100,
            y: 100,
            w: 200,
            h: 200,
            at: 0.3,
            transform: { keys: [{ at: 0.4, scale: 0 }, { at: 0.9, scale: 0.5 }] },
            anim: { w: [{ at: 1.1, v: 200 }, { at: 1.4, v: 260 }] },
          },
          { use: 'shape', id: 'dot1', shape: 'ellipse', x: 10, y: 10, w: 20, h: 20, at: 0.1 },
          { use: 'shape', id: 'dot2', shape: 'ellipse', x: 40, y: 10, w: 20, h: 20, at: 0.2 },
        ],
      },
      { id: 'outro', dur: 3, layers: [{ use: 'shape', id: 'end', shape: 'rect', x: 0, y: 0, w: 10, h: 10 }] },
    ],
  });
}
