/**
 * website/src/data/palette.ts — the brand palette's source of record (D-264).
 *
 * What it is: every colour the Apelles brand is allowed to use, each one tied to
 * a real material in the Alexander Mosaic (Pompeii, c. 100 BC; now in the
 * National Archaeological Museum of Naples). The mosaic is believed to be a
 * Roman copy of a lost Hellenistic painting, and it is the one tangible object
 * with a credible documented link to Apelles himself — so the brand's colours
 * are quarried from it rather than invented.
 *
 * What it does NOT do: hold any colour that is not in this list, or any value
 * chosen because it looked nice. `src/styles/tokens.css` transcribes this file
 * verbatim and `tests/palette.test.ts` fails if the two ever disagree, the same
 * way D-255's tokens test guarded the site against the app's own theme.
 *
 * Provenance for the material claims — the first scientific campaign on the
 * mosaic, published 2025:
 *   Balassone et al., "From tiny to immense: Geological spotlight on the
 *   Alexander Mosaic (National Archaeological Museum of Naples, Italy) using
 *   non-invasive in situ analyses", PLOS ONE, January 2025.
 *   https://pmc.ncbi.nlm.nih.gov/articles/PMC11734927/
 * It discriminated ten tesserae colours and proposed geological provenances:
 * white from Carrara marble, dark greens from Greek serpentinite, black from
 * Iberian basalt, the reds and yellows from iron oxides — and, on Alexander's
 * own face and nowhere else in the work, several shades of pink whose
 * composition points to Portugal.
 */

export interface Pigment {
  /** The CSS custom property this becomes, without the leading `--`. */
  readonly token: string;
  /** The hex value. Lowercase, six digits, always. */
  readonly hex: string;
  /** The real material in the mosaic this colour is taken from. */
  readonly material: string;
  /** What the colour is allowed to be used for on this site. */
  readonly role: string;
}

/** The citation every claim in this file rests on. Printed on the site itself. */
export const SOURCE = {
  title:
    'From tiny to immense: Geological spotlight on the Alexander Mosaic (National Archaeological Museum of Naples, Italy) using non-invasive in situ analyses',
  publication: 'PLOS ONE',
  year: 2025,
  url: 'https://pmc.ncbi.nlm.nih.gov/articles/PMC11734927/',
} as const;

/**
 * The working palette. Two neutrals, two working colours, one signature.
 *
 * The discipline is the mosaic's own: the pink was imported from the far end of
 * the empire and spent on one face out of roughly two million tesserae. So the
 * rose below is spent on exactly one element per page — the single action that
 * page exists for — and appears nowhere else. `tests/palette.test.ts` enforces
 * that literally.
 */
export const PIGMENTS: readonly Pigment[] = [
  {
    token: 'pigment-marble',
    hex: '#f4efe6',
    material: 'Carrara marble tesserae — the mosaic’s whites',
    role: 'The page ground. Warm bone, never clinical white.',
  },
  {
    token: 'pigment-marble-deep',
    hex: '#eae2d4',
    material: 'The same marble, in the mosaic’s shaded passages',
    role: 'The second ground, for a band that needs to sit back from the first.',
  },
  {
    token: 'pigment-basalt',
    hex: '#1c1a17',
    material: 'Iberian basalt and Greek serpentinite — the mosaic’s darks',
    role: 'Ink, and the ground behind product imagery. A warm black, never #000.',
  },
  {
    token: 'pigment-basalt-soft',
    hex: '#4a443c',
    material: 'The same darks, thinned where the mosaic models a shadow',
    role: 'Secondary text. 8.5:1 on marble, so it is still readable prose.',
  },
  {
    token: 'pigment-terracotta',
    hex: '#a6432c',
    material: 'Iron-oxide reds — dominant across the whole work',
    role: 'The first working colour: links, emphasis, the active state.',
  },
  {
    token: 'pigment-ochre',
    hex: '#b4823a',
    material: 'Iron-oxide yellows — the other dominant across the work',
    role:
      'The second working colour. 3.0:1 on marble, so it is used for rules, marks and large display type — never for body text.',
  },
  {
    token: 'pigment-rose',
    hex: '#c98c86',
    material:
      'The pink imported from Portugal, used on Alexander’s face alone out of roughly two million tesserae',
    role:
      'The signature. Exactly one element per page — the one action that page exists for — carries it, as a fill under basalt text.',
  },
];

/** The one token that may appear only once per rendered page. */
export const SIGNATURE_TOKEN = 'pigment-rose';

/**
 * The typefaces, and why each one. Named here so the type system is a decision
 * on the record rather than three lines of CSS nobody can defend.
 */
export const TYPEFACES = {
  /**
   * Display and long-form prose. A variable text serif with a real optical-size
   * axis, drawn by Production Type for reading on screens. Chosen because
   * Apelles painted — a drawn, high-contrast serif is truer to that than a
   * chiselled Roman capital, and it sidesteps the Trajan-pastiche cliché that
   * every "ancient" brand reaches for first.
   */
  display: 'Newsreader',
  /**
   * Interface: navigation, labels, buttons. Restrained by design and drawn as a
   * companion to the serif family it ships beside, so the pairing is a real
   * system rather than two faces put next to each other and hoped for.
   */
  ui: 'Instrument Sans',
  /** Technical artefacts only: tool names, commands, ports, counts, timecode. */
  mono: 'IBM Plex Mono',
} as const;

/**
 * Faces this site must never use. Both are the standard "safe" defaults that
 * make a generated interface look generated — called out in this repo's own
 * CLAUDE.md and by impeccable.style alike, so the ban is tested, not trusted.
 */
export const BANNED_TYPEFACES = ['Inter', 'Space Grotesk'] as const;
