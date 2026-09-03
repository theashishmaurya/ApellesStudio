// Ambient module declaration for a plain, side-effect-only CSS import (no
// CSS-modules typed exports needed here — every `.css` import in this
// package, D-060 doc: is a global stylesheet, imported for its side effect
// only). Fixes the two pre-existing `tsc --noEmit` "Cannot find module or
// type declarations" errors this package carried (the library's own CSS
// import, D-051; `timeline-overrides.css`, D-060) rather than accepting a
// third one on the next stylesheet.
declare module '*.css';
