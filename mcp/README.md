# mcp/ — the MCP server

**Not built yet. Phase 3.**

Exposes the grade graph to an agent (Claude Code or any MCP client). Language TBD — Rust
(shares the core crate) or Python (D-008).

- Tool surface + design rules: [`../docs/07-mcp-surface.md`](../docs/07-mcp-surface.md)
- Core rule: **every mutating tool returns `{ rendered_frame_png, scopes }`** so the agent
  can see what it did — the `apply → inspect → adjust` loop.
- Talks to the Rust core over the same local socket the GUI uses.

## The agent loop (target)

```
read_scopes → match_to_reference → add_subject_mask → set_mask_adjust (pop)
  → add_subject_mask(invert) → set_mask_adjust (dark+blur) → apply_haze
  → request_human(refine matte) → read_scopes → export
```

One conversation + a few minutes of human mask cleanup = a graded talking-head shot.
