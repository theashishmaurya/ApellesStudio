# @chroma/ui

**Shared component kit** (D-039) — the generic, dependency-light primitives from
RapidRAW's `app/src/components/ui/`, so every tab draws from one kit instead of
hand-crafting its buttons and toggles.

Consumed by `@chroma/editor`, `@chroma/motion`, `@chroma/shell` (and, via the
re-export shims, `app/` itself).

## Deps

`react` + `clsx` + `lucide-react` **only**. If a component needs the app store,
a React context, `react-i18next`, `framer-motion`, or anything heavier, it does
**not** belong here yet.

## What's in it

| export | notes |
|---|---|
| `Button` | verbatim from RapidRAW |
| `Input` | verbatim from RapidRAW |
| `Text` | + the `typography` variant table (`TextVariants` / `TextWeights` / …), copied from `app/src/types/typography.ts` — the app keeps its own copy for direct-import call sites, keep the two in sync |
| `Switch` | knob slide reworked from a `framer-motion` spring to a CSS transform transition |
| `CollapsibleSection` | two `react-i18next` tooltip strings inlined (English) |

## The shim pattern

The real source lives here. `app/src/components/ui/<Name>.tsx` is now:

```ts
export { Button as default } from '@chroma/ui';
```

so the existing `import Button from '../ui/Button'` sites across `app/` keep
working with no change.

## Deferred (a later pass)

`Slider` (pulls `react-i18next` + `GLOBAL_KEYS` from the app-coupled
`AppProperties`), `Dropdown`, `ColorWheel`, `LUTControl`, `DepthRangePicker`,
`ImagePicker`, `GlobalTooltip`, `Resizer`, `AppProperties`, `ExportImport*` —
app-coupled or heavy, left in `app/`.

## Tailwind

`app/src/styles.css` has `@source "../../packages/ui/src"` so the app's Tailwind
build sees these classes. The classes resolve against the app's theme tokens
(`text-text-primary`, `bg-surface`, `bg-accent`, …); this package ships no CSS
of its own.
