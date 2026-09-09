# @apelles/ui

**Shared component kit** — shadcn/ui components on **Base UI** primitives, themed
onto the app's existing `--app-*` / `--color-*` CSS-var tokens (D-042, supersedes
the D-039 hand-extraction).

Consumed by `@apelles/editor`, `@apelles/shell`, `@apelles/motion`, and — via the
re-export shims in `app/src/components/ui/*.tsx` — `app/` itself.

## Setup: manual, not the CLI

`components.json` is present and canonical, but the shadcn **CLI was not used to
add components** — it can't cleanly target a workspace _library_ package (its
aliases assume an app with a `tsconfig` `paths` map and a real Tailwind entry
CSS). Instead every component is **hand-placed from shadcn's published source**:
the `new-york` style, taking the **Base UI variant** JSX (shadcn publishes Radix
and Base UI trees in parallel) and the classic token-based utility classes from
the `new-york-v4` tree. `cn` is the standard `twMerge(clsx(...))`.

Canonical structure is preserved exactly:

```
packages/ui/
  components.json                 ← shadcn config (style: new-york, baseColor: neutral, cssVariables)
  src/
    lib/utils.ts                  ← cn()
    hooks/use-mobile.ts
    components/ui/<component>.tsx  ← one file per component, Base UI + cn + mapped tokens
    styles.css                    ← the shadcn token @theme block (see "Theme" below)
    index.ts                      ← the public API (named exports)
    Text.tsx / typography.ts      ← RapidRAW typography component (kept)
    labeled-switch.tsx            ← RapidRAW row-toggle, rebuilt on <Switch>
    collapsible-section.tsx       ← RapidRAW accordion panel, rebuilt on <Collapsible>
```

## Deps (D-042)

Pinned in `package.json`:

| dep | version | for |
|---|---|---|
| `@base-ui/react` | `1.7.0` | the primitive layer (stable v1; package renamed from `@base-ui-components/react`) |
| `class-variance-authority` | `0.7.1` | `buttonVariants` / `tabsListVariants` |
| `clsx` | `2.1.1` | `cn` |
| `tailwind-merge` | `3.6.0` | `cn` |
| `cmdk` | `1.1.1` | `Command` |
| `react-resizable-panels` | `4.12.3` | `Resizable` (v4 API: `Group` / `Panel` / `Separator`) |
| `sonner` | `2.0.8` | `Toaster` |
| `lucide-react` | `^1.33.0` | icons (matches `app/`) |

(`react` is a peer in practice — the app owns the single copy.)

## Component inventory

**shadcn / Base UI — structural + generic:**

| export(s) | primitive | notes |
|---|---|---|
| `Button`, `buttonVariants`, `ButtonVariant`, `ButtonSize` | `@base-ui/react/button` | variants `default` \| `primary` \| `secondary` \| `outline` \| `ghost` \| `destructive` \| `link`; sizes `default` \| `xs` \| `sm` \| `lg` \| `icon(-xs/-sm/-lg)`. **Back-compat** — see below |
| `Dialog*` | `@base-ui/react/dialog` | Backdrop = overlay, Popup = content |
| `DropdownMenu*` | `@base-ui/react/menu` | full: sub-menus, checkbox / radio items |
| `ContextMenu*` | `@base-ui/react/context-menu` | ″ |
| `Tooltip*`, `TooltipProvider` | `@base-ui/react/tooltip` | Provider → Root → Trigger → Portal → Positioner → Popup |
| `Popover*` | `@base-ui/react/popover` | |
| `Tabs`, `TabsList`, `TabsTrigger`, `TabsContent`, `tabsListVariants` | `@base-ui/react/tabs` | `default` + `line` list variants |
| `Select*` | `@base-ui/react/select` | Trigger + Value + Icon, Portal → Positioner → Popup → List |
| `Command*`, `CommandDialog` | `cmdk` (+ our `Dialog`) | |
| `ResizablePanelGroup`, `ResizablePanel`, `ResizableHandle` | `react-resizable-panels` | |
| `Sheet*` | `@base-ui/react/dialog` | side-anchored dialog (`side` = top/right/bottom/left) |
| `Slider` | `@base-ui/react/slider` | Base UI drives the thumb — real animation, no framer-motion |
| `Switch` | `@base-ui/react/switch` | the **bare** shadcn switch |
| `ScrollArea`, `ScrollBar` | `@base-ui/react/scroll-area` | |
| `Separator` | `@base-ui/react/separator` | |
| `Input` | `@base-ui/react/input` | + `bgClassName` prop (default `bg-surface`) — back-compat. A `type="number"` gets `tabular-nums` and `NUMBER_INPUT_SPINNER_SUPPRESSION` — **no native spin buttons, app-wide** (B-113/D-253) |
| `ScrubbableNumberInput` | `<Input type="number">` + `useNumberField` | the app's numeric field: drag it horizontally to change the value (Resolve's "virtual slider"), click it to type an exact one. Added D-253 — see below |
| `Textarea` | plain `<textarea>` | (Base UI has no textarea primitive — canonical for shadcn too). Classes mirror `Input` field for field, same `bgClassName` prop/default. Added D-222 |
| `Label` | plain `<label>` | (Base UI has no Label primitive — canonical for shadcn too) |
| `Collapsible`, `CollapsibleTrigger`, `CollapsibleContent` | `@base-ui/react/collapsible` | |
| `Toaster` | `sonner` | theme via mapped CSS vars, no `next-themes` |

**Rebuilt RapidRAW composites (the shim targets):**

| export | rebuilt on | shim |
|---|---|---|
| `Text` + typography table | (unchanged) | `app/src/components/ui/Text.tsx` |
| `LabeledSwitch` | `<Switch>` | `app/src/components/ui/Switch.tsx` → `LabeledSwitch as default` |
| `CollapsibleSection` | `<Collapsible>` | `app/src/components/ui/CollapsibleSection.tsx` |
| `Button` (see above) | `<Button>` | `app/src/components/ui/Button.tsx` |
| `Input` (see above) | `<Input>` | `app/src/components/ui/Input.tsx` |

**Stays in `app/`** (D-042, craft-specific): `ColorWheel`, `LUTControl`,
`DepthRangePicker`, `Dropdown`, the grading `Slider`, `ImagePicker`,
`GlobalTooltip`, `Resizer`, `AppProperties`, `ExportImport*`.

## Numeric fields — `ScrubbableNumberInput` (D-253, finishing B-113)

Every numeric field in the app is this component, not a bare `<Input
type="number">`. It has **no spin buttons** (WebKit lays them out inside the
padding box and paints them over a right-aligned value; no amount of
`padding-right` can clear them — that was B-113's mistake) and instead uses the
gesture Resolve, Premiere/AE and Blender all use in their place:

- **Drag it horizontally** to change the value. **8px = one declared `step`**,
  quantised to whole steps. **Shift ×10**, **Cmd ÷10** (Adobe's convention;
  Cmd rather than Ctrl because Ctrl-drag is macOS's secondary click).
- **Click without moving** (under 4px, the same threshold the timeline's own
  `PointerSensor` uses) and it focuses normally so you can type an exact value.
  Arrow keys still step — suppressing the spin *button* does not disable a
  number input's keyboard stepping.
- **At rest** it shows a `step`-derived rounding of the value; **focused**, the
  exact stored number. Pass `roundDisplay: false` for a field whose `step` says
  nothing about its precision.
- `value: number | null` — `null` is a legitimately unset field, and `onClear`
  says what emptying it means. Omit `onClear` and clearing commits nothing.

The behaviour lives in `hooks/use-number-scrub.ts` — `useNumberScrub` (the
gesture alone) and `useNumberField` (the whole field, as props to spread). That
module is also published as the **`@apelles/ui/number-scrub` subpath**, which
imports nothing but React: `@apelles/motion` cannot import this package's barrel
(`@react-three/fiber`'s JSX augmentation vs. `Text.tsx`'s polymorphic `as` —
see `packages/motion/src/Button.tsx`) and uses the subpath to get the same
behaviour on its own raw `<input>` rather than a second hand-written copy.

Its behavioural tests live in `@apelles/editor`
(`ScrubbableNumberInput.dom.test.tsx`) because this package has no test tier
and that one owns the real-`PointerEvent` harness (D-142).

## Theme — one source, mapped

`src/styles.css` holds the **single** definition of the shadcn token names. It is
`@import`ed by `app/src/styles.css` right after `@import 'tailwindcss'`, so the
app's Tailwind-v4 build (`@tailwindcss/vite`) merges its `@theme` entries. Every
shadcn token is an **alias** of an existing RapidRAW var — no parallel palette,
no colour literals in any component (`--color-destructive` is the one pinned
value, and it lives in the theme block, never in a component).

| shadcn token | → | maps to | value (dark) |
|---|---|---|---|
| `--color-background` | | `--app-bg-primary` | `rgb(24,24,24)` |
| `--color-foreground` | | `--app-text-primary` | `rgb(232,234,237)` |
| `--color-card` / `--color-popover` | | `--app-surface` | `rgb(28,28,28)` |
| `--color-card-foreground` / `--color-popover-foreground` | | `--app-text-primary` | |
| `--color-primary` | | `--app-accent` | `rgb(255,255,255)` — the brand is white |
| `--color-primary-foreground` | | `--app-button-text` | `rgb(0,0,0)` |
| `--color-secondary` / `--color-muted` | | `--app-bg-secondary` | `rgb(35,35,35)` |
| `--color-secondary-foreground` | | `--app-text-primary` | |
| `--color-muted-foreground` | | `--app-text-secondary` | `rgb(158,158,158)` |
| `--color-accent-foreground` | | `--app-text-primary` | *(safety net — see below)* |
| `--color-border` / `--color-input` | | `--app-border-color` | `rgb(45,45,45)` |
| `--color-ring` | | `--app-accent` | white |
| `--color-destructive` | | *(pinned)* | `rgb(229,72,77)` — a red that reads on dark, near the fork's `text-red-400` |
| `--color-destructive-foreground` | | `--app-text-primary` | |
| `--radius` | | `--radius-md` | `8px` — reuse, no third radius scale |

All three themes in `app/src/utils/themes.ts` (dark / light / grey) set the
`--app-*` vars at runtime, so the shadcn tokens follow every theme automatically.

### The `--accent` collision — decision (a)

RapidRAW's `--color-accent` is already defined as the **brand** colour
(`= --app-accent = white`) and is used across the fork (`bg-accent`,
`text-accent`, …). shadcn's components want `bg-accent` to mean a **subtle hover
surface**.

**We do not redefine `--color-accent`.** Instead, the copied component source is
edited: every `hover:bg-accent` / `focus:bg-accent` / `data-highlighted:bg-accent`
/ `data-[selected=true]:bg-accent` (and the paired `text-accent-foreground`) is
changed to **`bg-muted` / `text-foreground`**. `--color-accent-foreground` is
still mapped (to `--app-text-primary`) as a harmless safety net for any missed
edit — the fork never uses that utility.

Result: exactly one definition per CSS var, zero visual change to existing fork
UI, and a shadcn `<Dialog>` / `<DropdownMenu>` sits next to a RapidRAW panel
looking like the same app.

## Button back-compat

The pre-D-042 hand-rolled `Button` took `size?: string` and `variant?: string`
(both **ignored**), `className`, and had a `className.includes('bg-surface')`
special case. The new `Button` is a superset:

- `variant` / `size` are real and typed; **`variant="primary"` is kept** as an
  alias of `default` (the white brand button) because call sites pass it;
- `className` still passes through, and because `cn()` runs `tailwind-merge`, a
  call site passing `className="bg-surface"` still wins over the variant's
  `bg-primary` — the old hack keeps working with **no special case** in the
  component;
- `default` (no variant) renders `bg-primary text-primary-foreground` =
  `bg-accent text-button-text` = the same white-on-black button as before.

`ConfirmModal`'s `confirmVariant?: string` prop (fed from `useUIStore`) is
narrowed to `ButtonVariant` at the one Button call site — the values passed are
always `'primary'` / `'destructive'`.

## Typography sync caveat (unchanged from D-039)

`src/typography.ts` is a **copy** of `app/src/types/typography.ts` — the app keeps
its own copy for the ~40 sites that import the constants directly. The two must
stay in sync (small, rarely-touched). Unifying them (a `@apelles/tokens` or
`@apelles/typography` both import) is a **later task**, out of D-042 scope.

## Tailwind

`app/src/styles.css` has `@source "../../packages/ui/src"` so the app's Tailwind
build scans these files for classes, and `@import '../../packages/ui/src/styles.css'`
for the token block. This package ships no compiled CSS of its own.
