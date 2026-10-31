# @apelles/tokens

The **one source of the design-token values** for the Apelles frontend workspace
(D-039, D-432). Pure TypeScript, no React, no CSS, no Tauri.

## What it holds

- `src/themes.ts`: every colour token's value per theme (`dark`, `light`, `grey`),
  `TOKEN_NAMES`, and `cssVariablesFor(theme)`, which gives the `--app-*` map the app
  writes onto `:root`. Dark is the designed theme (D-432); light and grey carry a
  value for every name but are not redesigned yet. Clip colours are opaque media
  colours and identical in every theme.
- `src/fonts.ts`: the UI font stacks. The system stack (SF Pro) is the default;
  Poppins is an opt-in setting. `resolveUiFontStack(setting)` never falls back to Poppins.

## How it reaches the UI

`app/src/utils/themes.ts` imports `cssVariablesFor`; `useAppInitialization` sets the
variables. `app/src/styles.css` `@theme` aliases each `--app-<name>` as the Tailwind
token `--color-<name>`, and `packages/ui/src/styles.css` maps the shadcn names onto
those. The type scale, radii and shadows are Tailwind v4 `@theme` variables in
`app/src/styles.css`, not here.

## Adding a token

Add the name to `TOKEN_NAMES`, give it a value in all three themes, add its
`--color-<name>: var(--app-<name>);` line in `app/src/styles.css` (or the ui
stylesheet for shadcn names). `npm test --workspace packages/tokens` fails if any of
those is missing, and it checks the contrast pairs that the redesign promises.

## Boundary

Values only. Component code uses the `--color-*` utilities (`bg-surface`,
`text-accent-text`), never a colour literal.
