/**
 * D-413 — the document's soundtrack: an AUDIO asset by content hash, with its
 * offset, volume, render flag and beat-analysis parameters checked at load.
 */
import { describe, expect, it } from "vitest";
import { AUDIO_ASSET_ID_PATTERN } from "../lib/assetId";
import { manifestSchema } from "./schema";
import { validateManifest } from "./validate";

const HASH = "c".repeat(64);
const doc = (soundtrack: unknown) => ({
  title: "t",
  scenes: [{ id: "s", dur: 2 }],
  soundtrack,
});

describe("soundtrack (D-413)", () => {
  it("takes an audio asset and its settings", () => {
    const parsed = manifestSchema.parse(
      doc({ src: `sha256:${HASH}.mp3`, offset: 12.5, volume: 0.6, render: true, meter: 3, tempoHint: 90 }),
    );
    expect(parsed.soundtrack).toEqual({ src: `sha256:${HASH}.mp3`, offset: 12.5, volume: 0.6, render: true, meter: 3, tempoHint: 90 });
    expect(validateManifest(doc({ src: `sha256:${HASH}.wav` })).ok).toBe(true);
  });

  it("refuses an image, a path, and out-of-range settings", () => {
    expect(manifestSchema.safeParse(doc({ src: `sha256:${HASH}.png` })).success).toBe(false);
    expect(manifestSchema.safeParse(doc({ src: "/Users/me/song.mp3" })).success).toBe(false);
    expect(manifestSchema.safeParse(doc({ src: `sha256:${HASH}.mp3`, volume: 2 })).success).toBe(false);
    expect(manifestSchema.safeParse(doc({ src: `sha256:${HASH}.mp3`, offset: -1 })).success).toBe(false);
    expect(manifestSchema.safeParse(doc({ src: `sha256:${HASH}.mp3`, meter: 9 })).success).toBe(false);
  });

  it("audio ids are their own pattern", () => {
    for (const ext of ["mp3", "wav", "m4a", "aac", "flac", "ogg"]) {
      expect(AUDIO_ASSET_ID_PATTERN.test(`sha256:${HASH}.${ext}`)).toBe(true);
    }
    expect(AUDIO_ASSET_ID_PATTERN.test(`sha256:${HASH}.svg`)).toBe(false);
  });
});
