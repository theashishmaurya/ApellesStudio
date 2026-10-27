/**
 * sourceCheck.ts — the static check a custom component's source must pass
 * before a draft version can exist (D-409).
 *
 * What it is: one function, `checkComponentSource(source, engineDir)`, built on
 * the TypeScript compiler API (a real parser and type checker, never a regex):
 *  1. **Imports** — only the modules in `allowlist.ts`, written statically. No
 *     relative paths, no dynamic `import()`, no `require`, no `import.meta`.
 *  2. **Banned constructs** (an AST walk): `Math.random`, `Date`,
 *     `performance`, timers and animation frames, the network (`fetch`,
 *     `XMLHttpRequest`, `WebSocket`, …), code from strings (`eval`, `Function`),
 *     the page and process globals (`window`, `globalThis`, `document`,
 *     `process`, …), `__TAURI__*`, storage, workers, and the reflection names
 *     that reach them anyway (`constructor`, `__proto__`) — each refused with
 *     a hint pointing at the deterministic way (`random(seed)` and
 *     `useCurrentFrame()` from `remotion`).
 *  3. **Types** — the source type-checks in strict mode against the real
 *     `remotion` / React types in this package's `node_modules` and the
 *     component contract (`componentApi.ts`, imported as `@apelles/component`),
 *     with a default-exported component.
 *  4. **Compile** — when all of that passes, the source is transpiled to one
 *     CommonJS module (React's automatic JSX runtime), which is what the
 *     library stores and the renderer evaluates (`runtime.tsx`).
 * Every problem is an issue in `motion_validate`'s shape with a line-precise
 * `path` (`source:12:5`). Hard-coded colours are WARNINGS (`hardcoded_colour`):
 * a component should read `theme.*`, but a white highlight is sometimes right.
 *
 * Where it runs: in Node, never in the webview — `scripts/check-component.mts`
 * (spawned by `apelles_motion::components`) and this package's tests. It only
 * imports `typescript` and `./allowlist.ts`, so Node can run it with plain type
 * stripping.
 *
 * What it does NOT do: execute the code, prove determinism (certification
 * renders it, `apelles_motion::components::prove`), or check the props
 * declaration (`componentDef.ts`'s `componentSpecIssues`).
 */
import ts from "typescript";
import * as path from "node:path";
import { ALLOWED_COMPONENT_IMPORTS } from "./allowlist.ts";
import type { ValidationIssue } from "../engine/issues";

export interface SourceCheckResult {
  /** no blocking issue: the source may become a draft */
  ok: boolean;
  /** blocking problems, in source order */
  issues: ValidationIssue[];
  /** non-blocking findings (hard-coded colours) */
  warnings: ValidationIssue[];
  /** the compiled CommonJS module, when `ok` */
  code?: string;
}

const RANDOM_HINT = 'use random(seed) from "remotion": seeded, so every render draws the same numbers';
const TIME_HINT = "drive time from useCurrentFrame() and useVideoConfig().fps, which is the same on every render";
const GLOBAL_HINT = "a component draws from its props, theme and frame only; it cannot reach the page or the app";

/** Identifiers a component may not reference as values, with why. */
const BANNED_GLOBALS: Readonly<Record<string, { code: string; message: string; hint: string }>> = (() => {
  const out: Record<string, { code: string; message: string; hint: string }> = {};
  const add = (names: string[], code: string, message: string, hint: string) => {
    for (const n of names) out[n] = { code, message: `${n}: ${message}`, hint };
  };
  add(["Date", "performance"], "banned_clock", "reads the wall clock, so two renders differ", TIME_HINT);
  add(
    ["setTimeout", "setInterval", "setImmediate", "clearTimeout", "clearInterval", "requestAnimationFrame", "cancelAnimationFrame", "requestIdleCallback", "queueMicrotask"],
    "banned_timer",
    "a timer runs on wall-clock time, not on the frame being rendered",
    TIME_HINT,
  );
  add(
    ["fetch", "XMLHttpRequest", "WebSocket", "EventSource", "navigator", "location", "importScripts", "Request", "Response"],
    "banned_network",
    "network and browser access is not allowed in a component",
    "pass data in through the component's props",
  );
  add(["eval", "Function"], "banned_eval", "evaluates code from a string", "write the logic in the component itself");
  add(
    ["window", "globalThis", "self", "document", "top", "parent", "frames", "opener", "global", "process", "require", "module", "exports", "Buffer"],
    "banned_global",
    "reaches outside the component",
    GLOBAL_HINT,
  );
  add(
    ["localStorage", "sessionStorage", "indexedDB", "caches", "crypto", "Worker", "SharedWorker", "WebAssembly", "postMessage"],
    "banned_global",
    "browser storage, workers and crypto are not available to a component",
    GLOBAL_HINT,
  );
  add(["__TAURI__", "__TAURI_INTERNALS__", "__TAURI_IPC__", "__TAURI_METADATA__"], "banned_global", "is the app's IPC bridge", GLOBAL_HINT);
  return out;
})();

/** Property names that reach the globals above through any object. */
const BANNED_PROPERTIES = new Set(["constructor", "__proto__", "__defineGetter__", "__defineSetter__", "__lookupGetter__"]);

/** A colour literal a component should probably read from the theme. */
const COLOUR_LITERAL = /^(#[0-9a-fA-F]{3,8}|rgba?\(.*\)|hsla?\(.*\))$/;

/** The virtual file name the source is checked as: inside the engine's own
 *  tree, so module resolution finds the engine's `node_modules`. */
function virtualFile(engineDir: string): string {
  return path.join(engineDir, "src", "custom", "__check__", "Component.tsx");
}

function where(sf: ts.SourceFile, pos: number): string {
  const { line, character } = sf.getLineAndCharacterOfPosition(pos);
  return `source:${line + 1}:${character + 1}`;
}

/** Is `node` inside a type (an annotation, an interface, a type alias)? A
 *  name used only as a type never runs. */
function inTypePosition(node: ts.Node): boolean {
  for (let n: ts.Node | undefined = node.parent; n; n = n.parent) {
    if (ts.isTypeNode(n) || ts.isInterfaceDeclaration(n) || ts.isTypeAliasDeclaration(n)) return true;
    if (ts.isStatement(n) || ts.isSourceFile(n)) return false;
  }
  return false;
}

/** Is identifier `node` a VALUE reference (not a property name, not a key,
 *  not a declaration's own name in a type)? */
function isValueReference(node: ts.Identifier): boolean {
  const p = node.parent;
  if (!p) return true;
  if (ts.isPropertyAccessExpression(p) && p.name === node) return false;
  if ((ts.isPropertyAssignment(p) || ts.isPropertyDeclaration(p) || ts.isMethodDeclaration(p) || ts.isPropertySignature(p) || ts.isMethodSignature(p) || ts.isGetAccessor(p) || ts.isSetAccessor(p)) && p.name === node) return false;
  if (ts.isBindingElement(p) && p.propertyName === node) return false;
  if ((ts.isImportSpecifier(p) || ts.isExportSpecifier(p)) && p.propertyName === node) return false;
  if (ts.isJsxAttribute(p) && p.name === node) return false;
  if (ts.isQualifiedName(p) && p.right === node) return false;
  if (ts.isLabeledStatement(p) || ts.isBreakOrContinueStatement(p)) return false;
  return !inTypePosition(node);
}

function walk(sf: ts.SourceFile, issues: ValidationIssue[], warnings: ValidationIssue[]): boolean {
  let hasDefault = false;
  const allowed = new Set<string>(ALLOWED_COMPONENT_IMPORTS);
  const refuse = (node: ts.Node, code: string, message: string, hint?: string) =>
    issues.push({ path: where(sf, node.getStart(sf)), code, message, ...(hint ? { hint } : {}) });

  const checkSpecifier = (spec: ts.Expression) => {
    if (!ts.isStringLiteral(spec)) return;
    if (!allowed.has(spec.text)) {
      refuse(
        spec,
        "banned_import",
        `"${spec.text}" is not an allowed import`,
        `a component may import: ${ALLOWED_COMPONENT_IMPORTS.join(", ")}`,
      );
    }
  };

  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node)) {
      checkSpecifier(node.moduleSpecifier);
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier) {
      checkSpecifier(node.moduleSpecifier);
    } else if (ts.isImportEqualsDeclaration(node)) {
      refuse(node, "banned_import", "import = require() is not allowed", "use a static import from the allowlist");
    } else if (ts.isExportAssignment(node) && !node.isExportEquals) {
      hasDefault = true;
    } else if ((ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) && node.modifiers) {
      const mods = node.modifiers.map((m) => m.kind);
      if (mods.includes(ts.SyntaxKind.ExportKeyword) && mods.includes(ts.SyntaxKind.DefaultKeyword)) hasDefault = true;
    } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      refuse(node, "dynamic_import", "dynamic import() is not allowed", "import statically from the allowlist");
    } else if (ts.isMetaProperty(node) && node.keywordToken === ts.SyntaxKind.ImportKeyword) {
      refuse(node, "banned_global", "import.meta reaches outside the component", GLOBAL_HINT);
    } else if (ts.isWithStatement(node)) {
      refuse(node, "banned_syntax", "a with statement is not allowed");
    } else if (ts.isPropertyAccessExpression(node)) {
      const name = node.name.text;
      if (name === "random" && ts.isIdentifier(node.expression) && node.expression.text === "Math") {
        refuse(node, "banned_random", "Math.random() differs on every render", RANDOM_HINT);
      } else if (BANNED_PROPERTIES.has(name)) {
        refuse(node.name, "banned_reflection", `.${name} can reach the page's globals`, GLOBAL_HINT);
      } else if (name.startsWith("__TAURI")) {
        refuse(node.name, "banned_global", `.${name} is the app's IPC bridge`, GLOBAL_HINT);
      }
    } else if (ts.isElementAccessExpression(node)) {
      const arg = node.argumentExpression;
      if (ts.isStringLiteralLike(arg)) {
        if (arg.text === "random" && ts.isIdentifier(node.expression) && node.expression.text === "Math") {
          refuse(node, "banned_random", "Math.random() differs on every render", RANDOM_HINT);
        }
      }
    } else if (ts.isStringLiteralLike(node)) {
      if (BANNED_PROPERTIES.has(node.text) || node.text.startsWith("__TAURI")) {
        refuse(node, "banned_reflection", `"${node.text}" can reach the page's globals`, GLOBAL_HINT);
      } else if (COLOUR_LITERAL.test(node.text.trim())) {
        warnings.push({
          path: where(sf, node.getStart(sf)),
          code: "hardcoded_colour",
          message: `"${node.text}" is a fixed colour`,
          hint: "read theme.accent, theme.text, theme.bg … (or a colour prop) so the component follows the document's theme",
        });
      }
    } else if (ts.isIdentifier(node)) {
      const banned = Object.prototype.hasOwnProperty.call(BANNED_GLOBALS, node.text) ? BANNED_GLOBALS[node.text] : undefined;
      if (banned && isValueReference(node)) refuse(node, banned.code, banned.message, banned.hint);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return hasDefault;
}

/** The strict compiler options a component is type-checked under. */
function checkOptions(engineDir: string): ts.CompilerOptions {
  return {
    strict: true,
    noEmit: true,
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    jsx: ts.JsxEmit.ReactJSX,
    lib: ["lib.es2022.d.ts", "lib.dom.d.ts"],
    types: [],
    skipLibCheck: true,
    esModuleInterop: true,
    allowSyntheticDefaultImports: true,
    paths: { "@apelles/component": [path.join(engineDir, "src", "custom", "componentApi.ts")] },
  };
}

function diagnosticIssue(d: ts.Diagnostic, code: string): ValidationIssue {
  const message = ts.flattenDiagnosticMessageText(d.messageText, "\n");
  const at = d.file && d.start !== undefined ? where(d.file, d.start) : "source";
  return { path: at, code, message };
}

/** Transpile a checked source to the CommonJS module the renderer evaluates. */
export function compileComponent(source: string): string {
  return ts.transpileModule(source, {
    fileName: "Component.tsx",
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
      jsx: ts.JsxEmit.ReactJSX,
      esModuleInterop: true,
    },
  }).outputText;
}

/**
 * Check one component's source; on success also compile it. `engineDir` is
 * this package's folder (where `node_modules` and `componentApi.ts` are found).
 * `typecheck: false` runs the parse, import and ban checks only (fast; tests of
 * the AST rules use it).
 */
export function checkComponentSource(source: string, engineDir: string, opts: { typecheck?: boolean } = {}): SourceCheckResult {
  const file = virtualFile(engineDir);
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TSX);
  const issues: ValidationIssue[] = [];
  const warnings: ValidationIssue[] = [];

  const options = checkOptions(engineDir);
  const host = ts.createCompilerHost(options, true);
  const baseGetSourceFile = host.getSourceFile.bind(host);
  host.getSourceFile = (name, languageVersion, onError, shouldCreate) =>
    path.resolve(name) === file ? sf : baseGetSourceFile(name, languageVersion, onError, shouldCreate);
  const baseFileExists = host.fileExists.bind(host);
  host.fileExists = (name) => path.resolve(name) === file || baseFileExists(name);
  const baseReadFile = host.readFile.bind(host);
  host.readFile = (name) => (path.resolve(name) === file ? source : baseReadFile(name));
  const program = ts.createProgram({ rootNames: [file], options, host });

  const syntax = program.getSyntacticDiagnostics(sf);
  for (const d of syntax) issues.push(diagnosticIssue(d, "syntax_error"));
  if (syntax.length > 0) return { ok: false, issues, warnings };

  const hasDefault = walk(sf, issues, warnings);
  if (!hasDefault) {
    issues.push({
      path: "source",
      code: "missing_default_export",
      message: "the component must be the module's default export",
      hint: "export default function MyComponent({ props, theme, width, height }: ComponentProps<Props>) { … }",
    });
  }
  if (opts.typecheck !== false && issues.length === 0) {
    for (const d of program.getSemanticDiagnostics(sf)) issues.push(diagnosticIssue(d, "type_error"));
  }
  issues.sort((a, b) => a.path.localeCompare(b.path, undefined, { numeric: true }));
  if (issues.length > 0) return { ok: false, issues, warnings };
  return { ok: true, issues, warnings, code: compileComponent(source) };
}
