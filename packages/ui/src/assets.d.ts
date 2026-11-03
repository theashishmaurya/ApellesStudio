/** A bundled raster asset: Vite resolves the import to its served URL. */
declare module '*.png' {
  const src: string;
  export default src;
}
