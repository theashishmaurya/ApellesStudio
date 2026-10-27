// D-416 — the Colorist's brand applier: the kit's LUT, from the project's
// snapshot, in ONE adjustment write (one Colorist history entry).
import { beforeEach, describe, expect, it, vi } from 'vitest';

const invoke = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...args: unknown[]) => invoke(...args) }));

const { applyBrandToColorist } = await import('./useColoristBrandApplier');
const { useEditorStore } = await import('../store/useEditorStore');
const { INITIAL_ADJUSTMENTS } = await import('../utils/adjustments');
const { starterKit } = await import('@apelles/brand');
type Adjustments = typeof INITIAL_ADJUSTMENTS;

const LUT = `sha256:${'d'.repeat(64)}.cube`;
const kit = () => ({ ...starterKit('acme', 'Acme'), look: { lut: LUT, intensity: 70, name: 'Warm film' } });

beforeEach(() => {
  invoke.mockReset();
  invoke.mockResolvedValue({ size: 33 });
  useEditorStore.setState({
    adjustments: { ...INITIAL_ADJUSTMENTS },
    selectedImage: { path: '/shots/a.mov' } as never,
  });
});

describe('applyBrandToColorist', () => {
  it('writes the LUT once, from the project snapshot, at the kit intensity', async () => {
    const writes: Adjustments[] = [];
    const set = (fn: (prev: Adjustments) => Adjustments) => {
      const next = fn(useEditorStore.getState().adjustments);
      writes.push(next);
      useEditorStore.setState({ adjustments: next });
    };
    const out = await applyBrandToColorist(set, { kit: kit(), assetsDir: '/p.chroma/brand/assets', options: {} });
    expect(out).toMatchObject({ ok: true, changed: true });
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({
      lutPath: `/p.chroma/brand/assets/${'d'.repeat(64)}.cube`,
      lutName: 'Warm film',
      lutSize: 33,
      lutIntensity: 70,
    });
    expect(invoke).toHaveBeenCalledWith('load_and_parse_lut', { path: `/p.chroma/brand/assets/${'d'.repeat(64)}.cube` });

    // Applying again changes nothing.
    const again = await applyBrandToColorist(set, { kit: kit(), assetsDir: '/p.chroma/brand/assets', options: {} });
    expect(again).toMatchObject({ ok: true, changed: false });
    expect(writes).toHaveLength(1);
  });

  it('a kit without a look changes nothing; no open shot is an error', async () => {
    const set = vi.fn();
    expect(await applyBrandToColorist(set, { kit: starterKit('x', 'X'), assetsDir: '/a', options: {} })).toMatchObject({ changed: false });
    useEditorStore.setState({ selectedImage: null });
    expect(await applyBrandToColorist(set, { kit: kit(), assetsDir: '/a', options: {} })).toEqual({ ok: false, error: 'no shot is open in the Colorist' });
    expect(set).not.toHaveBeenCalled();
  });
});
