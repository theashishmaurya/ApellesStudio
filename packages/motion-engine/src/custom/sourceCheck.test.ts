/**
 * D-409 — the static check of a custom component's source: every banned
 * construct refused with a line-precise issue and a hint, the import allowlist
 * enforced, a real type error caught, and a good component compiled.
 */
import { describe, expect, it } from "vitest";
import * as path from "node:path";
import { checkComponentSource, compileComponent } from "./sourceCheck";
import { ALLOWED_COMPONENT_IMPORTS } from "./allowlist";

const ENGINE = path.resolve(__dirname, "..", "..");

const GOOD = `import { AbsoluteFill, random, useCurrentFrame, interpolate } from "remotion";
import type { ComponentProps } from "@apelles/component";

type Props = { count: number; color?: string };

export default function Dots({ props, theme, width, height }: ComponentProps<Props>) {
  const frame = useCurrentFrame();
  const t = interpolate(frame, [0, 30], [0, 1], { extrapolateRight: "clamp" });
  return (
    <AbsoluteFill>
      {Array.from({ length: props.count }, (_, i) => (
        <div
          key={i}
          style={{
            position: "absolute",
            left: random(\`x\${i}\`) * width,
            top: random(\`y\${i}\`) * height * t,
            width: 8,
            height: 8,
            background: props.color ?? theme.accent,
          }}
        />
      ))}
    </AbsoluteFill>
  );
}
`;

/** A component body with one statement replaced, for the ban-list cases. */
const withLine = (line: string) => `import { AbsoluteFill, useCurrentFrame } from "remotion";
export default function C() {
  const frame = useCurrentFrame();
  ${line}
  return <AbsoluteFill />;
}
`;

const ast = (source: string) => checkComponentSource(source, ENGINE, { typecheck: false });

describe("checkComponentSource — banned constructs", () => {
  const cases: [string, string, string][] = [
    ["Math.random", "const r = Math.random();", "banned_random"],
    ["Math['random']", 'const r = Math["random"]();', "banned_random"],
    ["Date", "const d = Date.now();", "banned_clock"],
    ["new Date", "const d = new Date();", "banned_clock"],
    ["performance.now", "const p = performance.now();", "banned_clock"],
    ["fetch", 'fetch("https://example.com");', "banned_network"],
    ["XMLHttpRequest", "const x = new XMLHttpRequest();", "banned_network"],
    ["WebSocket", 'const w = new WebSocket("ws://x");', "banned_network"],
    ["eval", 'eval("1");', "banned_eval"],
    ["new Function", 'const f = new Function("return 1");', "banned_eval"],
    ["dynamic import", 'import("remotion");', "dynamic_import"],
    ["require", 'const m = require("fs");', "banned_global"],
    ["process", "const e = process.env;", "banned_global"],
    ["window", "const w = window.innerWidth;", "banned_global"],
    ["globalThis", "const g = globalThis;", "banned_global"],
    ["document", 'document.title = "x";', "banned_global"],
    ["__TAURI__ global", "const t = __TAURI__;", "banned_global"],
    ["__TAURI_INTERNALS__ property", "const o: Record<string, unknown> = {}; const t = o.__TAURI_INTERNALS__;", "banned_global"],
    ["setTimeout", "setTimeout(() => 1, 10);", "banned_timer"],
    ["setInterval", "setInterval(() => 1, 10);", "banned_timer"],
    ["requestAnimationFrame", "requestAnimationFrame(() => 1);", "banned_timer"],
    ["constructor escape", "const F = [].filter.constructor;", "banned_reflection"],
    ["computed constructor", 'const F = ([] as unknown as Record<string, unknown>)["constructor"];', "banned_reflection"],
    ["localStorage", 'localStorage.setItem("a", "b");', "banned_global"],
    ["import.meta", "const u = import.meta.url;", "banned_global"],
  ];
  for (const [name, line, code] of cases) {
    it(`refuses ${name} with a line-precise ${code}`, () => {
      const r = ast(withLine(line));
      expect(r.ok).toBe(false);
      const hit = r.issues.find((i) => i.code === code);
      expect(hit, JSON.stringify(r.issues)).toBeDefined();
      expect(hit?.path).toMatch(/^source:4:\d+$/);
      expect(hit?.message.length).toBeGreaterThan(0);
      expect(r.code).toBeUndefined();
    });
  }

  it("points Math.random and the clock at Remotion's deterministic tools", () => {
    expect(ast(withLine("const r = Math.random();")).issues[0].hint).toMatch(/random\(seed\)/);
    expect(ast(withLine("const d = Date.now();")).issues[0].hint).toMatch(/useCurrentFrame/);
  });

  it("allows the banned NAMES where they are not references (a prop key, a type)", () => {
    const r = ast(`import { AbsoluteFill } from "remotion";
type Win = { window: number; fetch: string };
export default function C() {
  const o: Win = { window: 1, fetch: "x" };
  return <AbsoluteFill style={{ opacity: o.window }} />;
}
`);
    expect(r.issues).toEqual([]);
    expect(r.ok).toBe(true);
  });
});

describe("checkComponentSource — imports", () => {
  it("refuses a module outside the allowlist, naming the allowlist", () => {
    const r = ast(`import fs from "fs";
import { AbsoluteFill } from "remotion";
export default function C() { return <AbsoluteFill />; }
`);
    expect(r.issues[0]).toMatchObject({ path: "source:1:16", code: "banned_import" });
    expect(r.issues[0].hint).toContain("remotion");
  });

  it("refuses relative imports and re-exports from outside the allowlist", () => {
    expect(ast(`import x from "./x";\nexport default function C() { return null; }\n`).issues[0].code).toBe("banned_import");
    expect(ast(`export * from "lodash";\nexport default function C() { return null; }\n`).issues[0].code).toBe("banned_import");
  });

  it("accepts every allowlisted module", () => {
    const imports = ALLOWED_COMPONENT_IMPORTS.map((m, i) => `import * as m${i} from "${m}";`).join("\n");
    const r = ast(`${imports}\nexport default function C() { return null; }\n`);
    expect(r.issues).toEqual([]);
  });

  it("requires a default export", () => {
    const r = ast(`import { AbsoluteFill } from "remotion";\nexport function C() { return <AbsoluteFill />; }\n`);
    expect(r.issues.map((i) => i.code)).toEqual(["missing_default_export"]);
  });
});

describe("checkComponentSource — syntax, types, warnings, compile", () => {
  it("reports a syntax error with its line", () => {
    const r = ast(`export default function C() { return <div>; }\n`);
    expect(r.ok).toBe(false);
    expect(r.issues[0].code).toBe("syntax_error");
    expect(r.issues[0].path).toMatch(/^source:1:\d+$/);
  });

  it("type-checks against the real remotion types and the component contract", () => {
    const r = checkComponentSource(
      `import { useCurrentFrame } from "remotion";
import type { ComponentProps } from "@apelles/component";
export default function C({ props }: ComponentProps<{ count: number }>) {
  const label: string = useCurrentFrame();
  return <div>{label}{props.count}{props.missing}</div>;
}
`,
      ENGINE,
    );
    expect(r.ok).toBe(false);
    expect(r.issues.every((i) => i.code === "type_error")).toBe(true);
    expect(r.issues.map((i) => i.path)).toEqual(["source:4:9", "source:5:42"]);
  }, 30_000);

  it("passes and compiles a good component, warning only on a fixed colour", () => {
    const r = checkComponentSource(GOOD.replace("theme.accent", '"#ff0055"'), ENGINE);
    expect(r.issues).toEqual([]);
    expect(r.ok).toBe(true);
    expect(r.warnings).toEqual([expect.objectContaining({ code: "hardcoded_colour", path: expect.stringMatching(/^source:20:40$/) })]);
    expect(r.code).toContain('require("remotion")');
    expect(r.code).toContain('require("react/jsx-runtime")');
    expect(r.code).not.toContain("@apelles/component");
  }, 30_000);

  it("compiles deterministically", () => {
    expect(compileComponent(GOOD)).toBe(compileComponent(GOOD));
  });
});
