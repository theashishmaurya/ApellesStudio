/**
 * @apelles/brand — the `brand_*` registry on the control bridge (D-416).
 *
 * What it is: the shell of the D-020 bridge for brand ops, the same shape as
 * `useMotionControl` (listen on `chroma://request`, answer only `brand_*`,
 * announce a B-272 claim, B-280 re-subscription on a hot update). The ops are
 * `createBrandOps`; this file only wires them to the real store and Tauri
 * commands. Mounted once from the app (`App.tsx`), because a brand kit belongs
 * to no single tab; Colorist's catch-all registry defers the `brand_` prefix.
 *
 * What it does NOT do: any op logic.
 */
import { useEffect } from 'react';
import { emit, listen } from '@tauri-apps/api/event';
import { assertRequestLive, newBridgeClaim } from '@apelles/bridge';
import { runAsAgent } from '@apelles/history';
import { assertProjectIdentity } from '@apelles/store';
import { applyBrandKit, availableBrandTabs } from './appliers';
import { createBrandOps, type BrandOpsContext } from './brandOps';
import { brandAssetsDir, importBrandAsset, projectBrandAssetsDir, readProjectKit, useBrandStore } from './io';

const BRAND_OP_PREFIX = 'brand_';

const REGISTRY_EVALUATION = Symbol('useBrandControl evaluation');

function safeUnlisten(unlistenPromise: Promise<() => void>): void {
  unlistenPromise
    .then((f) => f())
    .catch(() => {
      /* the listener is already gone either way (HMR teardown race) */
    });
}

/** The ops' context wired to the real store, Tauri commands and applier
 *  registry: what the bridge runs, and what the op-layer tests drive (with
 *  Tauri's `invoke` replaced by an in-memory backend). */
export function liveBrandOpsContext(): BrandOpsContext {
  const store = () => useBrandStore.getState();
  return {
    library: () => ({ kits: store().kits, loadErrors: store().loadErrors }),
    reload: () => store().reload(),
    saveKit: (kit) => store().saveKit(kit),
    deleteKit: (id) => store().deleteKit(id),
    readProjectKit: async () => {
      const kit = await readProjectKit();
      useBrandStore.setState({ project: kit });
      return kit;
    },
    setProjectKit: (kit) => store().setProjectKit(kit),
    importAsset: (path) => importBrandAsset(path),
    libraryAssetsDir: () => brandAssetsDir(),
    projectAssetsDir: () => projectBrandAssetsDir(),
    availableTabs: () => availableBrandTabs(),
    apply: (tabs, kit, assetsDir, options) => applyBrandKit(tabs, { kit, assetsDir, options }),
  };
}

export function useBrandControl(): void {
  const evaluation = REGISTRY_EVALUATION;
  useEffect(() => {
    void evaluation;
    const OPS = createBrandOps(liveBrandOpsContext());

    const bridge = newBridgeClaim(BRAND_OP_PREFIX);
    const unlistenP = listen('chroma://request', async (ev: { payload?: unknown }) => {
      const payload = (ev?.payload || {}) as { id?: string; op?: string; args?: Record<string, unknown> };
      const { id, op, args } = payload;
      if (!bridge.isForMe(payload)) return;
      if (typeof op !== 'string' || !op.startsWith(BRAND_OP_PREFIX)) return;
      const respond = (body: unknown) => emit(`chroma://response/${id}`, body);
      const fn = OPS[op];
      if (!fn) {
        void respond({ ok: false, error: `unknown brand op: ${op}` });
        return;
      }
      try {
        await assertProjectIdentity(op);
        assertRequestLive(payload); // B-314
        const result = await runAsAgent(() => fn(args || {}));
        const error = typeof result.error === 'string' ? result.error : null;
        void respond({ ok: error === null, error, result });
      } catch (e) {
        void respond({ ok: false, error: e instanceof Error ? e.message : String(e), result: null });
      }
    });

    let subscribed = true;
    void unlistenP.then(() => {
      if (subscribed) void emit('chroma://bridge-ready', bridge.claim);
    });
    return () => {
      subscribed = false;
      safeUnlisten(unlistenP);
    };
  }, [evaluation]);
}
