/**
 * `app/src` — no icon COMPONENT NAME is ever rendered as visible label text (B-403).
 *
 * What it is: a source scan, not a DOM test. It reads every `.tsx` under
 * `app/src` and the `packages` tree and fails if a JSX text node contains a word
 * ending in `Icon`.
 *
 * What it does NOT do: check that labels are good, translated, or present. It
 * catches exactly one mistake, the one that actually happened.
 *
 * **Why it exists.** D-294's repo-wide lucide → Phosphor rename rewrote the
 * identifier `Save` to `FloppyDiskIcon` — and took the word "Save" in the
 * button's own label with it, because the label happened to be the same word as
 * the component. The Colorist's Save button read **"FloppyDiskIcon project"**
 * to every user from 2026-09-10 until 2026-11-14. Nothing caught it: it
 * compiles, it renders, it is the right size and colour, and no test asserted
 * what the button says. A mechanical rename can do this again to any label
 * whose word matches an icon's name (Image, Link, Play, Text, Crop...), so the
 * guard is mechanical too.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const REPO = join(HERE, '..', '..');

function tsxFiles(dir: string, out: string[] = []): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of entries) {
    if (name === 'node_modules' || name === 'dist' || name.startsWith('.')) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) tsxFiles(full, out);
    else if (name.endsWith('.tsx') && !name.includes('.test.')) out.push(full);
  }
  return out;
}

/**
 * JSX text between a `>` and a `<` — what a user can actually read.
 *
 * The first version of this over-collected and matched CODE spanning several
 * lines (`const Icon = maskType?.icon || CircleIcon;`, `export const PlusIcon:
 * React.FC<`), i.e. false failures. A guard that cries wolf is a guard someone
 * deletes, so it is narrow on purpose: a run of text with exactly ONE non-empty
 * line, carrying no code punctuation. A label that does not look like a label
 * is not checked, which is the right way round for this.
 */
function visibleText(src: string): string[] {
  const out: string[] = [];
  for (const m of src.matchAll(/>([^<>{}]+)</g)) {
    const lines = m[1].split('\n').map((l) => l.trim()).filter(Boolean);
    if (lines.length !== 1) continue;
    const text = lines[0];
    if (/[;=()]/.test(text)) continue;
    out.push(text);
  }
  return out;
}

/** A bare word ending in `Icon` — `FloppyDiskIcon`, `PlusIcon`, … */
const ICON_WORD = /\b[A-Z][A-Za-z0-9]*Icon\b/;

describe('B-403 — an icon component name is never shown to the user as text', () => {
  const roots = [join(REPO, 'app', 'src'), join(REPO, 'packages')];
  const files = roots.flatMap((r) => tsxFiles(r));

  it('scans a meaningful number of files (the scan itself must not silently find nothing)', () => {
    // Without this, a broken path would make every assertion below vacuously
    // pass — which is the failure mode B-404 was logged for.
    expect(files.length).toBeGreaterThan(50);
  });

  it('no visible label contains an icon component name', () => {
    const offenders: string[] = [];
    for (const file of files) {
      const src = readFileSync(file, 'utf8');
      for (const text of visibleText(src)) {
        if (ICON_WORD.test(text)) {
          offenders.push(`${relative(REPO, file)}: ${text}`);
        }
      }
    }
    expect(
      offenders,
      `An icon component's NAME is being rendered as label text. This is what B-403 was: a\n` +
        `lucide -> Phosphor rename turned the word "Save" into "FloppyDiskIcon" inside the label\n` +
        `itself, and the Colorist's button read "FloppyDiskIcon project" for two months.\n` +
        `Offenders:\n  ${offenders.join('\n  ')}`,
    ).toEqual([]);
  });
});
