/**
 * @apelles/ui — shared component kit (D-042).
 *
 * shadcn/ui components on Base UI primitives (`@base-ui/react`), themed onto the
 * app's existing `--app-*` / `--color-*` CSS-var token system (see
 * `./styles.css`). Structural + generic components live here; RapidRAW's
 * craft-specific grading components (ColorWheel, LUTControl, DepthRangePicker,
 * the grading sliders) stay in `app/`.
 *
 * The 5 pre-D-042 hand-extracted components (Button, Switch, Input, Text,
 * CollapsibleSection) are rebuilt on this base. The `app/src/components/ui/*.tsx`
 * re-export shims still point here, so the ~100 `import X from '../ui/X'` call
 * sites are unchanged (the Switch shim now points at `LabeledSwitch` — the
 * row-style toggle — while `Switch` is the bare shadcn switch).
 *
 * Setup: hand-placed from shadcn's `new-york` style + Base UI variant source
 * (the shadcn CLI can't target a workspace *library* package cleanly). Canonical
 * structure: `lib/utils.ts` (`cn`), `components/ui/<name>.tsx`, this barrel.
 * `components.json` records the config. Full inventory + theme table: README.
 */

// ── the cn util ────────────────────────────────────────────────────────────────
export { cn } from './lib/utils';

// ── shadcn / Base UI components ────────────────────────────────────────────────
export { Button, buttonVariants } from './components/ui/button';
export type { ButtonVariant, ButtonSize } from './components/ui/button';
export {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogOverlay,
  DialogPortal,
  DialogTitle,
  DialogTrigger,
} from './components/ui/dialog';
export {
  DropdownMenu,
  DropdownMenuPortal,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuItem,
  DropdownMenuCheckboxItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuSub,
  DropdownMenuSubTrigger,
  DropdownMenuSubContent,
} from './components/ui/dropdown-menu';
export {
  ContextMenu,
  ContextMenuTrigger,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuCheckboxItem,
  ContextMenuRadioItem,
  ContextMenuLabel,
  ContextMenuSeparator,
  ContextMenuShortcut,
  ContextMenuGroup,
  ContextMenuPortal,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuRadioGroup,
} from './components/ui/context-menu';
export { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider } from './components/ui/tooltip';
export {
  Popover,
  PopoverTrigger,
  PopoverContent,
  PopoverHeader,
  PopoverTitle,
  PopoverDescription,
} from './components/ui/popover';
export { Tabs, TabsList, TabsTrigger, TabsContent, tabsListVariants } from './components/ui/tabs';
export {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectScrollDownButton,
  SelectScrollUpButton,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from './components/ui/select';
export {
  Command,
  CommandDialog,
  CommandInput,
  CommandList,
  CommandEmpty,
  CommandGroup,
  CommandItem,
  CommandShortcut,
  CommandSeparator,
} from './components/ui/command';
export { ResizablePanelGroup, ResizablePanel, ResizableHandle } from './components/ui/resizable';
export {
  Sheet,
  SheetTrigger,
  SheetClose,
  SheetContent,
  SheetHeader,
  SheetFooter,
  SheetTitle,
  SheetDescription,
} from './components/ui/sheet';
export { Slider } from './components/ui/slider';
export { Switch } from './components/ui/switch';
export { ScrollArea, ScrollBar } from './components/ui/scroll-area';
export { Separator } from './components/ui/separator';
export { Input, NUMBER_INPUT_SPINNER_SUPPRESSION } from './components/ui/input';
export { ScrubbableNumberInput } from './components/ui/scrubbable-number-input';
export type { ScrubbableNumberInputProps } from './components/ui/scrubbable-number-input';
// The scrub gesture and the numeric-display arithmetic (D-253). Also reachable
// as the `@apelles/ui/number-scrub` subpath, which is how `@apelles/motion` —
// which cannot import this barrel at all — gets at it; see that module's doc.
export {
  DISPLAY_DECIMALS_MAX,
  NUMBER_SCRUB,
  SCRUB_DECIMALS_MAX,
  clampNumber,
  displayDecimals,
  displayNumber,
  scrubFactor,
  scrubbedValue,
  stepDecimals,
  useNumberField,
  useNumberScrub,
} from './hooks/use-number-scrub';
export type {
  NumberField,
  NumberFieldInputProps,
  NumberFieldOptions,
  NumberScrub,
  NumberScrubOptions,
} from './hooks/use-number-scrub';
export { Textarea } from './components/ui/textarea';
export { Label } from './components/ui/label';
export { Collapsible, CollapsibleTrigger, CollapsibleContent } from './components/ui/collapsible';
export { Toaster } from './components/ui/sonner';

// ── rebuilt RapidRAW composites (shim targets) ────────────────────────────────
export { default as Text } from './Text';
export { default as LabeledSwitch } from './labeled-switch';
export { default as CollapsibleSection } from './collapsible-section';

export * from './typography';
