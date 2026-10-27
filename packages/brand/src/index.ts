/**
 * @apelles/brand — brand kits (D-416). The domain half: schema, contrast,
 * library rules, the store and Tauri boundary, the per-tab applier registry and
 * the `brand_*` ops. The Brand panel is the `@apelles/brand/ui` subpath, kept off
 * this barrel so a tab (Motion's three.js JSX typing, D-253) can import the
 * domain without pulling in `@apelles/ui`.
 */
export * from './kit';
export * from './contrast';
export * from './library';
export * from './references';
export * from './appliers';
export * from './io';
export { createBrandOps, type BrandOpsContext, type BrandOp } from './brandOps';
export { liveBrandOpsContext, useBrandControl } from './useBrandControl';
