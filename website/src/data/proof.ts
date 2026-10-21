/**
 * website/src/data/proof.ts — published videos made with Apelles.
 *
 * What it is: real, public videos the owner made with the app, on their own
 * YouTube channel (@theashishmaurya). Titles are YouTube's own (from its oEmbed
 * endpoint, 2026-10-21), not rewritten for the page.
 * What it does NOT do: list anything not actually made with Apelles, or any
 * third party's video.
 */

export interface ProofVideo {
  /** The YouTube video id. */
  readonly id: string;
  readonly title: string;
  /** One plain line on what it is. */
  readonly note: string;
  /** Second to start playing at, as the owner linked it. */
  readonly start: number;
  readonly url: string;
}

export const PROOF_VIDEOS: readonly ProofVideo[] = [
  {
    id: 'sNPRhoaWXec',
    title: 'Why Nvidia Just Made the Biggest Deal in Its History (It’s Not About Training AI)',
    note: 'A published explainer, made with Apelles.',
    start: 0,
    url: 'https://www.youtube.com/watch?v=sNPRhoaWXec',
  },
  {
    id: 'q8Fx0hGQSwg',
    title: '1000+ Hours of Building AI Agent Memory in 8 Min',
    note: 'A published walkthrough, made with Apelles.',
    start: 22,
    url: 'https://www.youtube.com/watch?v=q8Fx0hGQSwg&t=22s',
  },
];
