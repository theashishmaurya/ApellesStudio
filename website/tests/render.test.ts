/**
 * render.test.ts — every section really renders, and renders the real thing
 * (D-255's approach, D-264's content).
 *
 * Uses Astro's Container API, the framework's own supported way to render a
 * component in isolation. Assertions are about substance, not markup shape:
 * that the headline actually carries the value proposition, that the
 * demonstration is genuinely interactive rather than a picture of one, that the
 * differentiation names the tools it is differentiating from instead of
 * gesturing at "other apps", that the honest gaps survive into the HTML, and
 * that no section quietly grows a fabricated social-proof claim.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { experimental_AstroContainer as AstroContainer } from 'astro/container';
import { parseHTML } from 'linkedom';

import Hero from '../src/components/Hero.astro';
import Demo from '../src/components/Demo.astro';
import Difference from '../src/components/Difference.astro';
import Rooms from '../src/components/Rooms.astro';
import Machine from '../src/components/Machine.astro';
import Beta from '../src/components/Beta.astro';
import Nav from '../src/components/Nav.astro';
import Footer from '../src/components/Footer.astro';

import { TOOL_TOTALS } from '../src/data/mcp.ts';
import { TABS, STATUS } from '../src/data/product.ts';

let container: AstroContainer;
const html: Record<string, string> = {};

const doc = (key: string) => parseHTML(`<body>${html[key]}</body>`).document;
const text = (key: string) => html[key].replace(/\s+/g, ' ');

/**
 * The words a visitor actually reads: markup, styles and scripts stripped, and
 * whitespace collapsed. Used for the brand checks, because raw markup carries
 * Astro's dev script URL — which contains this checkout's own absolute path and
 * so its directory name — and that is a fact about the test machine, not about
 * anything the site says.
 */
const visible = (key: string) =>
  html[key]
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ');

beforeAll(async () => {
  container = await AstroContainer.create();
  const parts: Array<[string, Parameters<typeof container.renderToString>[0]]> = [
    ['hero', Hero],
    ['demo', Demo],
    ['difference', Difference],
    ['rooms', Rooms],
    ['machine', Machine],
    ['beta', Beta],
    ['nav', Nav],
    ['footer', Footer],
  ];
  for (const [key, component] of parts) {
    html[key] = await container.renderToString(component);
  }
});

describe('every section renders', () => {
  it.each(['hero', 'demo', 'difference', 'rooms', 'machine', 'beta', 'nav', 'footer'])(
    '%s produces real markup',
    (key) => {
      expect(html[key].length).toBeGreaterThan(500);
    },
  );
});

describe('the headline carries the whole proposition on its own', () => {
  it('is one h1, benefit-led, and short enough to actually be read', () => {
    const h1 = doc('hero').querySelector('h1');
    expect(h1).not.toBeNull();
    const words = (h1?.textContent ?? '').trim().split(/\s+/).filter(Boolean);
    expect(words.length, 'a headline nobody finishes is not a headline').toBeLessThan(30);
  });

  it('speaks from the visitor’s side of the screen, not the architecture’s', () => {
    const h1 = (doc('hero').querySelector('h1')?.textContent ?? '').toLowerCase();
    expect(h1).toContain('you');
    // No feature-speak in the headline: these are things the SYSTEM has, and
    // the headline's job is what the PERSON gets.
    for (const jargon of ['multi-track', 'mcp', 'gpu', 'timeline', 'keyframe']) {
      expect(h1, `the headline should not sell "${jargon}"`).not.toContain(jargon);
    }
  });

  it('names the objection a non-editor actually has', () => {
    expect(text('hero').toLowerCase()).toContain('never learned to edit');
  });

  it('offers exactly one next step', () => {
    expect(doc('hero').querySelectorAll('a').length).toBe(1);
  });
});

describe('the demonstration is a working editor, not a picture of one', () => {
  it('has a scrubbable playhead with real slider semantics', () => {
    const track = doc('demo').querySelector('[data-track]');
    expect(track).not.toBeNull();
    expect(track?.getAttribute('role')).toBe('slider');
    expect(track?.getAttribute('tabindex')).toBe('0');
    expect(track?.getAttribute('aria-valuemin')).toBe('0');
    expect(Number(track?.getAttribute('aria-valuemax'))).toBeGreaterThan(0);
  });

  it('has the two drag-to-scrub numeric fields, with a declared step (D-253)', () => {
    const nums = doc('demo').querySelectorAll('[data-num]');
    expect(nums.length).toBe(2);
    for (const n of nums) {
      expect(n.getAttribute('type')).toBe('number');
      expect(Number(n.getAttribute('step'))).toBeGreaterThan(0);
      expect(n.getAttribute('aria-label')).toBeTruthy();
    }
  });

  it('ships the real drag constants from the app’s own spec', async () => {
    // 8px per declared step, 4px click/drag threshold. Astro extracts the
    // component script into its own module, so this asserts on the source that
    // gets bundled rather than on the rendered HTML.
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const src = readFileSync(
      fileURLToPath(new URL('../src/components/Demo.astro', import.meta.url)),
      'utf8',
    );
    expect(src).toContain('PX_PER_STEP = 8');
    expect(src).toContain('THRESHOLD = 4');
  });

  it('cross-fades between real screenshots that exist on disk', async () => {
    const { existsSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const shots = [...doc('demo').querySelectorAll('img.shot')];
    expect(shots.length).toBeGreaterThanOrEqual(3);
    // Each frame must be a distinct image — a "filmstrip" of one repeated shot
    // would technically scrub and show nothing.
    const srcs = shots.map((s) => s.getAttribute('src'));
    expect(new Set(srcs).size).toBe(srcs.length);
    for (const img of shots) {
      const src = img.getAttribute('src') ?? '';
      expect(src.startsWith('/shots/')).toBe(true);
      const onDisk = fileURLToPath(new URL(`../public${src}`, import.meta.url));
      expect(existsSync(onDisk), `${src} is referenced but not in public/`).toBe(true);
    }
  });

  it('the first frame carries real alt text; the decorative rest do not', () => {
    const shots = [...doc('demo').querySelectorAll('img.shot')];
    expect((shots[0].getAttribute('alt') ?? '').length).toBeGreaterThan(30);
    for (const img of shots.slice(1)) {
      expect(img.getAttribute('alt')).toBe('');
      expect(img.getAttribute('aria-hidden')).toBe('true');
    }
  });

  it('says plainly that there is no demo video', () => {
    expect(text('demo').toLowerCase()).toContain('no recorded product demo yet');
  });
});

describe('the differentiation names what it is differentiating from', () => {
  it('names both professional tools, rather than gesturing at "other apps"', () => {
    expect(text('difference')).toContain('DaVinci Resolve');
    expect(text('difference')).toContain('Premiere Pro');
  });

  it('makes the argument about a design assumption, not a boast', () => {
    const t = text('difference').toLowerCase();
    expect(t).toContain('built for');
    expect(t).toContain('assumption');
    // Explicitly not the vague claim the brief rejected.
    for (const boast of ['easier to use', 'faster than', 'better than', 'the best video']) {
      expect(t, `"${boast}" is exactly the empty claim this page must not make`).not.toContain(
        boast,
      );
    }
  });

  it('is respectful about the tools it names, and says so on the page', () => {
    expect(text('difference').toLowerCase()).toContain('magnificent');
  });
});

describe('the three rooms are named for what a person does in them', () => {
  it('renders all three', () => {
    for (const tab of TABS) {
      expect(html.rooms).toContain(tab.name);
      expect(text('rooms')).toContain(tab.line);
    }
  });

  it('is a list, not a card grid — the pattern this site deliberately avoids', () => {
    expect(doc('rooms').querySelectorAll('ol > li.room').length).toBe(TABS.length);
  });

  it('shows what you would actually say to each room', () => {
    // Curly quotes, because the copy is set with real punctuation.
    expect((text('rooms').match(/“/g) ?? []).length).toBeGreaterThanOrEqual(TABS.length);
  });
});

describe('the "how it is built" section publishes only verified numbers', () => {
  it('prints the shipped total', () => {
    expect(html.machine).toContain(String(TOOL_TOTALS.shipped));
  });

  it('discloses the debug-only tools rather than folding them into the total', () => {
    expect(html.machine).toContain(String(TOOL_TOTALS.debugOnly));
    expect(text('machine')).toContain('compiled out of a production build');
  });

  it('says where the number came from, rather than asserting it', () => {
    expect(html.machine).toContain('mcp/server.py');
  });
});

describe('the beta form is real', () => {
  it('requires a valid email and describes its own error region', () => {
    const input = doc('beta').querySelector('#beta-email');
    expect(input?.getAttribute('type')).toBe('email');
    expect(input?.hasAttribute('required')).toBe(true);
    expect(input?.getAttribute('aria-describedby')).toBe('beta-email-err');
  });

  it('has a live status region for submit feedback', () => {
    const status = doc('beta').querySelector('[data-status]');
    expect(status?.getAttribute('role')).toBe('status');
    expect(status?.getAttribute('aria-live')).toBe('polite');
  });

  it('carries a honeypot that is hidden from assistive tech', () => {
    const hp = doc('beta').querySelector('input[name="_gotcha"]');
    expect(hp).not.toBeNull();
    expect(hp?.getAttribute('tabindex')).toBe('-1');
  });

  it('is marked as still using the placeholder endpoint', () => {
    const form = doc('beta').querySelector('[data-beta-form]');
    expect(form?.getAttribute('data-placeholder')).toBe('true');
    expect(form?.getAttribute('data-endpoint')).toContain('YOUR_FORM_ID');
  });

  it('every field has a label', () => {
    const d = doc('beta');
    for (const id of ['beta-email', 'beta-role']) {
      expect(d.querySelector(`label[for="${id}"]`), `${id} has no label`).not.toBeNull();
    }
  });

  /**
   * The submit button is the signature — the single rose element on the home
   * page. The script that drives the form finds it by [data-submit] and
   * [data-label], so this also pins the contract between the two.
   */
  it('the submit button is the signature, and the script can still find it', () => {
    const button = doc('beta').querySelector('button[data-submit]');
    expect(button).not.toBeNull();
    expect(button?.getAttribute('class')).toContain('signature');
    expect(button?.getAttribute('type')).toBe('submit');
    expect(doc('beta').querySelector('[data-label]')).not.toBeNull();
  });
});

describe('no fabricated social proof anywhere on the page', () => {
  const all = () => Object.values(html).join('\n');

  it.each([
    /trusted by/i,
    /\bjoin \d[\d,]* /i,
    /\b\d[\d,]*\+? (?:users|creators|editors|downloads|installs)\b/i,
    /testimonial/i,
    /\d+ ?(?:k|m)\+ downloads/i,
    /rated \d(\.\d)? (?:stars|\/ ?5)/i,
  ])('does not match %s', (pattern) => {
    expect(all()).not.toMatch(pattern);
  });

  it('states the pre-release stage instead', () => {
    expect(all()).toContain(STATUS.stage);
  });
});

describe('the rebrand is complete in what actually renders', () => {
  it('every section says Apelles', () => {
    const named = ['hero', 'difference', 'nav', 'footer'];
    for (const key of named) {
      expect(html[key], `${key} never names the product`).toContain('Apelles');
    }
  });

  /**
   * Asserted on visible TEXT, not raw markup. Astro's container emits a dev
   * script URL containing this checkout's own absolute path, which happens to
   * include the old directory name — a fact about where the test is running,
   * not about what the site says. The one legitimate mention that IS visible
   * text is the screenshot disclosure, checked separately below.
   */
  it('no rendered section still says the old product name in visible text', () => {
    for (const key of Object.keys(html)) {
      const body = visible(key);
      // Sanity: the stripper produced real prose, so this is not passing on ''.
      // The nav is the shortest section at ~74 characters of visible text.
      expect(body.length, `${key} produced no visible text to check`).toBeGreaterThan(40);
      const stray = [...body.matchAll(/chroma/gi)].filter((m) => {
        const around = body.slice(Math.max(0, m.index - 120), m.index + 120);
        return !/title bar/i.test(around);
      });
      expect(stray.map((m) => m[0]), `${key} still carries the old brand`).toEqual([]);
    }
  });

  it('discloses that the screenshots predate the rename, rather than retouching them', () => {
    const flat = visible('demo');
    expect(flat).toContain('predate the rename');
    expect(flat).toContain('retaken rather than retouched');
  });
});

describe('accessibility basics', () => {
  it('the footer and nav expose landmark labels', () => {
    expect(doc('footer').querySelector('nav')?.getAttribute('aria-label')).toBeTruthy();
    expect(doc('nav').querySelector('nav')?.getAttribute('aria-label')).toBeTruthy();
  });

  it('the nav does not carry the signature — that belongs to the page’s one action', () => {
    expect(html.nav).not.toContain('class="signature"');
  });
});
