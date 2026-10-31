// Ambient module declaration for a plain, side-effect-only CSS import (no
// CSS-modules typed exports needed here — every `.css` import in this
// package, D-060 doc: is a global stylesheet, imported for its side effect
// only). Fixes the pre-existing `tsc --noEmit` "Cannot find module or
// type declarations" error a side-effect CSS import (`timeline.css`, D-060)
// raised, rather than accepting one more on the next stylesheet.
declare module '*.css';
