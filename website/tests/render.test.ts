/**
 * render.test.ts — every section really renders, and renders the real thing
 * (D-255).
 *
 * Uses Astro's Container API, the framework's own supported way to render a
 * component in isolation. Assertions are about substance, not markup shape:
 * that the hero is genuinely interactive, that the honest "no screenshot yet"
 * note survives into the HTML, and that no section quietly grows a fabricated
 * social-proof claim.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { experimental_AstroContainer as AstroContainer } from 'astro/container';
import { parseHTML } from 'linkedom';

import Hero from '../src/components/Hero.astro';
import Tabs from '../src/components/Tabs.astro';
import Mcp from '../src/components/Mcp.astro';
import LocalFirst from '../src/components/LocalFirst.astro';
import Beta from '../src/components/Beta.astro';
import Nav from '../src/components/Nav.astro';
import Footer from '../src/components/Footer.astro';

import { TOOL_TOTALS } from '../src/data/mcp.ts';
import { TABS } from '../src/data/product.ts';

let container: AstroContainer;
const html: Record<string, string> = {};

const doc = (key: string) => parseHTML(`<body>${html[key]}</body>`).document;

beforeAll(async () => {
  container = await AstroContainer.create();
  const parts: Array<[string, Parameters<typeof container.renderToString>[0]]> = [
    ['hero', Hero],
    ['tabs', Tabs],
    ['mcp', Mcp],
    ['local', LocalFirst],
    ['beta', Beta],
    ['nav', Nav],
    ['footer', Footer],
  ];
  for (const [key, component] of parts) {
    html[key] = await container.renderToString(component);
  }
});

describe('every section renders', () => {
  it.each(['hero', 'tabs', 'mcp', 'local', 'beta', 'nav', 'footer'])(
    '%s produces real markup',
    (key) => {
      expect(html[key].length).toBeGreaterThan(500);
    },
  );
});

describe('the hero is a working editor, not a picture of one', () => {
  it('has a scrubbable playhead with real slider semantics', () => {
    const track = doc('hero').querySelector('[data-track]');
    expect(track).not.toBeNull();
    expect(track?.getAttribute('role')).toBe('slider');
    expect(track?.getAttribute('tabindex')).toBe('0');
    expect(track?.getAttribute('aria-valuemin')).toBe('0');
    expect(Number(track?.getAttribute('aria-valuemax'))).toBeGreaterThan(0);
  });

  it('has the two drag-to-scrub numeric fields, with a declared step (D-253)', () => {
    const nums = doc('hero').querySelectorAll('[data-num]');
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
      fileURLToPath(new URL('../src/components/Hero.astro', import.meta.url)),
      'utf8',
    );
    expect(src).toContain('PX_PER_STEP = 8');
    expect(src).toContain('THRESHOLD = 4');
  });

  it('cross-fades between real screenshots that exist on disk', async () => {
    const { existsSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const shots = [...doc('hero').querySelectorAll('img.shot')];
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
    const shots = [...doc('hero').querySelectorAll('img.shot')];
    expect((shots[0].getAttribute('alt') ?? '').length).toBeGreaterThan(30);
    for (const img of shots.slice(1)) {
      expect(img.getAttribute('alt')).toBe('');
      expect(img.getAttribute('aria-hidden')).toBe('true');
    }
  });

  it('says plainly that there is no demo video', () => {
    // Collapse the source's line wrapping before matching the sentence.
    const text = html.hero.replace(/\s+/g, ' ').toLowerCase();
    expect(text).toContain('no recorded product demo yet');
  });
});

describe('the tabs section is honest about missing imagery', () => {
  it('shows a real screenshot only for the tab that has one', () => {
    const imgs = doc('tabs').querySelectorAll('img');
    const withShot = TABS.filter((t) => t.shot !== null);
    expect(imgs.length).toBe(withShot.length);
  });

  it('prints the explanatory note for every tab with no capture', () => {
    for (const t of TABS.filter((t) => t.shot === null)) {
      expect(t.shotNote).toBeTruthy();
      expect(html.tabs).toContain('No screenshot of the ' + t.name + ' tab has been captured yet');
    }
  });

  it('lists every shipped capability from the scope data', () => {
    for (const t of TABS) {
      expect(t.shipped.length).toBeGreaterThan(4);
      // Spot-check the first of each, which is enough to prove the loop runs.
      const first = t.shipped[0].split('—')[0].slice(0, 40);
      expect(html.tabs).toContain(first.slice(0, 25));
    }
  });
});

describe('the MCP section publishes only verified numbers', () => {
  it('prints the shipped total', () => {
    expect(html.mcp).toContain(String(TOOL_TOTALS.shipped));
  });

  it('discloses the debug-only tools rather than folding them into the total', () => {
    expect(html.mcp).toContain(String(TOOL_TOTALS.debugOnly));
    expect(html.mcp).toContain('compiled out of a production build');
  });

  it('shows the Motion tab’s zero alongside the others', () => {
    expect(html.mcp).toContain('no MCP tools yet');
  });

  it('gives a runnable install command, not pseudocode', () => {
    expect(html.mcp).toContain('claude mcp add chroma');
    expect(html.mcp).toContain('requirements.txt');
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
    expect(all()).toContain('Pre-release');
  });
});

describe('accessibility basics', () => {
  it('the footer and nav expose landmark labels', () => {
    expect(doc('footer').querySelector('nav')?.getAttribute('aria-label')).toBeTruthy();
    expect(doc('nav').querySelector('nav')?.getAttribute('aria-label')).toBeTruthy();
  });

  it('every image outside the decorative filmstrip has alt text', () => {
    for (const img of doc('tabs').querySelectorAll('img')) {
      expect((img.getAttribute('alt') ?? '').length).toBeGreaterThan(20);
    }
  });
});
