import { defineConfig } from 'vite';
import react, { reactCompilerPreset } from '@vitejs/plugin-react';
import babel from '@rolldown/plugin-babel';
import tailwindcss from '@tailwindcss/vite';

const host = process.env.TAURI_DEV_HOST;

// React Compiler (D-091) — `@vitejs/plugin-react` v6 dropped its internal
// Babel in favor of oxc/Rust, so the compiler runs as its own separate
// Babel-transform stage via `@rolldown/plugin-babel` + the plugin's own
// `reactCompilerPreset()`, not the old `react({ babel: {...} })` inline
// option (removed in v6). Covers every workspace package consumed as
// source here (editor/motion/shell/ui/player/history/bridge/tokens — all
// `main: ./src/index.ts`, no separate build step), including
// `motion-engine` primitive files whenever they're imported directly as
// source by another package in this same build (its own separate
// Remotion/webpack bundler, used only for standalone `remotion render`, is
// untouched by this). Bailouts (e.g. hand-written memoization the compiler
// can't safely preserve, `try/finally`) are logged, not build errors — the
// compiler just leaves that one component uncompiled.
// https://react.dev/learn/react-compiler/installation
export default defineConfig(async () => ({
  plugins: [
    tailwindcss(),
    react(),
    babel({
      presets: [
        reactCompilerPreset({
          logger: {
            logEvent(filename, event) {
              if (event.kind !== 'CompileError') return;
              console.warn(`[react-compiler] bailout in ${filename}: ${event.detail?.reason ?? event.detail?.description ?? event.kind}`);
            },
          },
        }),
      ],
    }),
  ],

  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: 'ws',
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      ignored: ['**/src-tauri/**'],
    },
  },

  envPrefix: ['VITE_', 'TAURI_ENV_*'],
  build: {
    minify: !process.env.TAURI_ENV_DEBUG ? 'esbuild' : false,
    sourcemap: !!process.env.TAURI_ENV_DEBUG,
  },
}));
