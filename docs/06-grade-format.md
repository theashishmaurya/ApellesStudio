# 06 — The grade document

Status: **draft schema**, will change once the engine is read.

## Principle

**The grade is code.** One `grade.json` per shot. It is the single source of truth — the
GUI mutates it, the MCP layer mutates it, the renderer reads it and only it. No hidden
state in the app. It lives in the user's project repo, next to the footage, in git.

Why this matters and why a GUI-first tool can't do it:
- `git diff` a look change → reviewable
- generate a grade from a prompt → it's just JSON
- replay a grade months later → bit-identical
- a series' "reference grade" is a file you copy, not a screenshot you eyeball

## Shape (v1, display-referred)

```jsonc
{
  "schema": "chroma.grade/1",
  "shot": {
    "source": "footage/C017.mov",     // relative to project root
    "in": 91,                          // source frame
    "out": 2465,
    "fps": 24,
    "reference": "refs/series-look.png" // optional, for match_to_reference
  },
  "color": {
    "space": "rec709",                 // v1: rec709 only. v2: acescg | ...
    "outputTransform": "rec709"
  },

  // ordered, non-destructive. renderer applies top → bottom.
  "stack": [
    {
      "id": "primary",
      "type": "primary",
      "enabled": true,
      "params": {
        "exposure": 0.13, "contrast": 1.05,
        "whites": 0, "blacks": -0.03, "highlights": 0, "shadows": 0.1,
        "temperature": 5490, "tint": 0,
        "saturation": 1.1, "vibrance": 0.1
      }
    },
    {
      "id": "curve-master",
      "type": "curve",
      "channel": "master",             // master | r | g | b
      "points": [[0,0.04],[0.5,0.5],[1,0.95]]
    },
    {
      "id": "wheels",
      "type": "wheels",
      "params": {
        "lift":  { "hue": 0, "amount": 0 },
        "gamma": { "hue": 0, "amount": 0 },
        "gain":  { "hue": 45, "amount": 0.05 }
      }
    },
    {
      "id": "look",
      "type": "lut",
      "path": "luts/food-pop.cube",
      "strength": 0.3
    },

    // --- masked adjustments ---
    {
      "id": "subject-pop",
      "type": "masked",
      "mask": "m_subject",
      "adjust": { "type": "primary", "params": { "exposure": 0.15, "vibrance": 0.2, "contrast": 1.1 } }
    },
    {
      "id": "bg-haze",
      "type": "masked",
      "mask": "m_bg",
      "adjust": {
        "type": "compound",
        "ops": [
          { "type": "primary", "params": { "exposure": -0.6, "saturation": 0.6, "blacks": 0.03 } },
          { "type": "effect", "effect": "blur.gaussian", "params": { "radius": 14 } },
          { "type": "effect", "effect": "dehaze", "params": { "amount": -0.4 } }
        ]
      }
    }
  ],

  // masks are referenced by id from `stack[].mask`
  "masks": {
    "m_subject": {
      "kind": "subject",               // shape | depth | subject | brush
      "source": "sam2",
      "prompt": "person",
      "matte": "mattes/m_subject.rle",  // per-frame RLE, produced by the sidecar, cached
      "refine": { "feather": 2, "edgeAware": true },
      "corrections": [                  // human paint strokes layered over the AI matte
        { "frame": 52, "op": "add", "path": "..." }
      ]
    },
    "m_bg": { "kind": "subject", "source": "sam2", "prompt": "person", "invert": true },
    "m_depth_far": {
      "kind": "depth",
      "source": "depth-anything-v2",
      "map": "depth/shot.dpt",
      "range": [0.55, 1.0],            // normalized depth band this mask covers
      "falloff": 0.15
    },
    "m_lamp": {
      "kind": "shape",
      "shape": "rectangle",
      "geometry": { "cx": 0.07, "cy": 0.8, "w": 0.15, "h": 0.4, "rot": 0 },
      "feather": 70,
      "keyframes": []                   // [{frame, geometry}] when animated/tracked
    }
  },

  "meta": {
    "created": "2026-09-01T00:00:00Z",
    "engine": "chroma/0.0.0",
    "history": []                       // agent + human change log, each an undoable diff
  }
}
```

## Rules

- **Order matters.** `stack` is applied in array order. Masked entries stack additively on
  what's below (learned from Palmier: a masked grade does not *replace*, it adds — so
  `bg-haze` darkening and `lamp` brightening in the same region fight, and the values
  must be planned as deltas).
- **Masks are data, not pixels.** `subject`/`depth` masks reference a cached matte/map the
  sidecar produced; `shape` masks are pure geometry. Human `corrections` layer on top.
- **`.cube` export = flatten the non-masked `primary`/`curve`/`wheels`/`lut` entries only.**
  Masked and depth entries cannot be baked to a LUT — they need the compositor (Chroma's
  renderer, or re-created in the editor).
- **`meta.history`** is the agent+human audit trail — every mutation, who made it, the
  before/after diff. Powers the GUI "agent activity" feed and undo.

## Validation

serde (Rust core) + a JSON Schema published for external tools. A malformed doc fails
loud with the offending path, never renders wrong silently.
