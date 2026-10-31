/**
 * DOM queries for the clip Inspector's D-432 (P4) structure: collapsible
 * `[data-chroma-section]`s, `InspectorRow` label cells and icon tabs whose
 * name is an `aria-label`. Shared so the Inspector's dom tests do not each
 * re-derive the selectors.
 */

/** The section titles on screen, in render order. */
export function sectionTitles(root: ParentNode | null | undefined): string[] {
  return [...(root?.querySelectorAll('[data-chroma-section]') ?? [])].map(
    (s) => s.querySelector('button[aria-expanded] > span')?.textContent ?? '',
  );
}

/** A tab trigger by its accessible name (the tabs are icon-only). */
export function tabByLabel(root: ParentNode | null | undefined, label: string): HTMLElement | undefined {
  return [...(root?.querySelectorAll('[role="tab"]') ?? [])].find(
    (t) => (t.getAttribute('aria-label') ?? t.textContent) === label,
  ) as HTMLElement | undefined;
}

/** Every tab's accessible name, in order. */
export function tabLabels(root: ParentNode | null | undefined): string[] {
  return [...(root?.querySelectorAll('[role="tab"]') ?? [])].map(
    (t) => t.getAttribute('aria-label') ?? t.textContent ?? '',
  );
}

/** The number field on the `InspectorRow` whose visible label is `label`;
 *  the nth match (default the first) when a label repeats (EQ bands). */
export function fieldByLabel(root: ParentNode | null | undefined, label: string, nth = 0): HTMLInputElement | undefined {
  const hits = [...(root?.querySelectorAll('[data-slot="inspector-label"]') ?? [])].filter(
    (l) => l.textContent === label,
  );
  const row = hits[nth]?.closest('[data-slot="inspector-row"]');
  return (row?.querySelector('input') as HTMLInputElement | null) ?? undefined;
}
