/**
 * Build-time feature switches (D-391).
 *
 * What it is: the one place the app reads which optional surfaces this build ships.
 * What it does: turns Vite build env into plain booleans. Vite replaces
 * `import.meta.env.VITE_*` with a literal at build time, so a disabled surface is
 * folded out of the bundle, not hidden behind a runtime check a user could flip.
 * What it does NOT do: gate anything on the Rust side. The MCP server's `motion_*`
 * tools are gated by `apelles-mcp`'s own `motion` Cargo feature; `app/package.json`'s
 * `tauri:before-build` sets both in one line so they cannot drift apart.
 */

/**
 * The Motion tab. Off in the release bundle until Motion's export toolchain (Node.js +
 * headless Chrome) is downloaded on demand; on everywhere else, including dev.
 */
export const MOTION_TAB_ENABLED = import.meta.env.VITE_APELLES_MOTION !== 'off';
