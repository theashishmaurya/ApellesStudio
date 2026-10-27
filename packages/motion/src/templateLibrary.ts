/**
 * @apelles/motion — the template LIBRARY: built-in starters plus the user's
 * saved templates (D-407).
 *
 * What it is: pure functions over `MotionTemplate`s. The built-ins ship as
 * data (`./templates/*.json`, checked on import like any other template); the
 * user library comes off disk through `templateLibraryIO.ts` and is sanitised
 * here, ONE FILE AT A TIME — a bad file drops itself with a reported error and
 * never takes the library down with it (D-399's rule, per file now that each
 * template is its own file). Lookup, listing with tags, and the version bump a
 * re-save under an existing id gets.
 *
 * What it does NOT do: I/O (`templateLibraryIO.ts`), instantiation
 * (`templates.ts`), or any manifest write.
 */
import { parseTemplate, type MotionTemplate } from '@apelles/motion-engine/src/templateDef';
import { formatIssues } from '@apelles/motion-engine/src/engine/validate';
import { checkTemplateUsable } from './templates';
import logoReveal from './templates/logo-reveal.json';
import featureCallout from './templates/feature-callout.json';
import statCounter from './templates/stat-counter.json';
import testimonial from './templates/testimonial.json';
import pricingCard from './templates/pricing-card.json';
import ctaEndCard from './templates/cta-end-card.json';

/** One library file that could not be used, and why. */
export interface TemplateLoadError {
  /** the file name (`<id>.json`) */
  file: string;
  error: string;
}

/** A template and where it lives. */
export interface ListedTemplate {
  template: MotionTemplate;
  source: 'builtin' | 'library';
}

/** The raw shape `chroma_motion_load_templates` returns. */
export interface RawTemplateLibrary {
  entries: { file: string; template: unknown }[];
  errors: TemplateLoadError[];
}

const BUILTIN_SOURCES: readonly unknown[] = [logoReveal, featureCallout, statCounter, testimonial, pricingCard, ctaEndCard];

/** The built-in starters, parsed. A built-in that does not parse is a bug in
 *  this repo (`templateLibrary.test.ts` proves each one does) — it is left
 *  out rather than crashing the tab, and the test is what catches it. */
export const BUILTIN_TEMPLATES: readonly MotionTemplate[] = BUILTIN_SOURCES.flatMap((raw) => {
  const parsed = parseTemplate(raw);
  return 'template' in parsed ? [parsed.template] : [];
});

/** built-in ids, which a library template may not reuse. */
export const BUILTIN_TEMPLATE_IDS: ReadonlySet<string> = new Set(BUILTIN_TEMPLATES.map((t) => t.id));

/**
 * What came off disk → the templates that are usable, plus one error per file
 * that is not (unparseable JSON is reported by the backend; a shape problem, a
 * file name that disagrees with the id, a built-in's id, or a body that does
 * not expand are reported here).
 */
export function sanitizeLoadedTemplates(raw: RawTemplateLibrary): { templates: MotionTemplate[]; errors: TemplateLoadError[] } {
  const templates: MotionTemplate[] = [];
  const errors: TemplateLoadError[] = [...raw.errors];
  for (const { file, template } of raw.entries) {
    const checked = checkTemplateUsable(template);
    if ('issues' in checked) {
      errors.push({ file, error: formatIssues(checked.issues) });
      continue;
    }
    const t = checked.template;
    if (`${t.id}.json` !== file) {
      errors.push({ file, error: `its id is "${t.id}", so the file must be named ${t.id}.json` });
    } else if (BUILTIN_TEMPLATE_IDS.has(t.id)) {
      errors.push({ file, error: `"${t.id}" is a built-in template's id` });
    } else {
      templates.push(t);
    }
  }
  return { templates, errors };
}

/** Built-ins first (in their order), then the library by name; `tag` filters. */
export function listTemplates(library: readonly MotionTemplate[], tag?: string): ListedTemplate[] {
  const all: ListedTemplate[] = [
    ...BUILTIN_TEMPLATES.map((template) => ({ template, source: 'builtin' as const })),
    ...[...library].sort((a, b) => a.name.localeCompare(b.name)).map((template) => ({ template, source: 'library' as const })),
  ];
  return tag ? all.filter((e) => e.template.tags?.includes(tag)) : all;
}

/** Every tag in use, sorted. */
export function templateTags(library: readonly MotionTemplate[]): string[] {
  const tags = new Set<string>();
  for (const { template } of listTemplates(library)) for (const t of template.tags ?? []) tags.add(t);
  return [...tags].sort();
}

/** The template with `id`, built-in or library. */
export function findTemplate(id: string, library: readonly MotionTemplate[]): ListedTemplate | null {
  return listTemplates(library).find((e) => e.template.id === id) ?? null;
}

/**
 * Ready `template` to be saved into `library`: a built-in id is refused; an id
 * already in the library becomes the next version of it (its stored `version`
 * + 1, whatever the incoming one said); a new id starts at its own version, or
 * 1.
 */
export function versionForSave(
  template: MotionTemplate,
  library: readonly MotionTemplate[],
): { template: MotionTemplate; previousVersion: number | null } | { error: string } {
  if (BUILTIN_TEMPLATE_IDS.has(template.id)) {
    return { error: `"${template.id}" is a built-in template's id; save under another id (a copy is fine)` };
  }
  const prev = library.find((t) => t.id === template.id);
  if (!prev) return { template, previousVersion: null };
  return { template: { ...template, version: prev.version + 1 }, previousVersion: prev.version };
}

/** The library with `template` added or replacing its id. */
export function upsertTemplate(library: readonly MotionTemplate[], template: MotionTemplate): MotionTemplate[] {
  const i = library.findIndex((t) => t.id === template.id);
  return i < 0 ? [...library, template] : library.map((t, k) => (k === i ? template : t));
}
