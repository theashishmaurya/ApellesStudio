/**
 * build-pack.mts — assemble the engine PACK a release app ships (D-417).
 *
 * What it is: `node scripts/build-pack.mts --out=<dir>` (run by the release
 * pre-build, `app/package.json`'s `tauri:before-build`) writes the smallest
 * folder that renders and checks Motion documents without this repository:
 *
 *   bundle/          `remotion bundle` of this engine (the renderer serves it),
 *                    chunk source maps dropped (only `bundle.js.map`, which the
 *                    renderer reads at start-up, is kept)
 *   scripts/         render.mts (the renderer) and check-component.mts
 *   src/             only the engine sources the component check imports or
 *                    type-checks against (found by asking TypeScript, not listed)
 *   components/      the certified built-in components
 *   node_modules/    @remotion/renderer and its runtime dependencies (no
 *                    bundler, no Studio), TypeScript's compiler and the default
 *                    libraries, and exactly the type declarations the component
 *                    check reads — each package with its licence files
 *   package.json, pack.json (remotionVersion + bundleKey, a content hash)
 *
 * What it does NOT contain: Node.js, Chrome Headless Shell or the Remotion
 * compositor binaries. Those are downloaded on demand by the app
 * (`apelles-motion-runtime`), from their publishers, with pinned checksums.
 *
 * It ends with a self-test from a copy OUTSIDE this repository (so Node cannot
 * fall back on the repo's own node_modules): `@remotion/renderer` loads, and
 * the component check passes every built-in and compiles it to exactly its
 * certified module.
 *
 * Deterministic: no timestamps; the bundle key is a hash of the bundle's files.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import ts from "typescript";
import { ALLOWED_COMPONENT_IMPORTS } from "../src/custom/allowlist.ts";

const engineDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
/** The package the renderer script imports; its runtime dependencies come along. */
const RENDERER_PACKAGE = "@remotion/renderer";
/** Per-platform binaries: downloaded by the app, never shipped (D-417). */
const DOWNLOADED_PREFIX = "@remotion/compositor-";
/** The one source map the renderer reads when it serves a bundle. */
const KEPT_SOURCE_MAP = "bundle.js.map";
const LICENCE_FILE = /^(licen[cs]e|copying|notice|thirdpartynoticetext)/i;
/** The TypeScript files the check needs at run time besides the default libraries. */
const TYPESCRIPT_FILES = ["package.json", "lib/typescript.js"];

const { values } = parseArgs({ options: { out: { type: "string" } } });
if (!values.out) {
  process.stderr.write("usage: node scripts/build-pack.mts --out=<dir>\n");
  process.exit(2);
}
const out = resolve(values.out);

function log(message: string): void {
  process.stdout.write(`build-pack: ${message}\n`);
}

function fail(message: string): never {
  process.stderr.write(`build-pack: ${message}\n`);
  process.exit(1);
}

/** `name`'s folder as Node would find it from `fromDir` (up the node_modules chain). */
function packageDir(fromDir: string, name: string): string {
  for (let dir = fromDir; ; dir = dirname(dir)) {
    const candidate = join(dir, "node_modules", name);
    if (existsSync(join(candidate, "package.json"))) return candidate;
    if (dirname(dir) === dir) fail(`cannot find ${name} from ${fromDir}`);
  }
}

/** Where an absolute file lands in the pack: engine files keep their engine
 *  path; anything in a node_modules keeps its path from the first node_modules. */
function packPath(abs: string): string {
  const marker = `${sep}node_modules${sep}`;
  const at = abs.indexOf(marker);
  if (at >= 0) return abs.slice(at + 1);
  const rel = relative(engineDir, abs);
  if (rel.startsWith("..")) fail(`${abs} is outside the engine and every node_modules`);
  return rel;
}

/** Every pack path written so far, with its source — two sources for one path is a build error. */
const written = new Map<string, string>();

function copyIntoPack(abs: string): void {
  const rel = packPath(abs);
  const previous = written.get(rel);
  if (previous !== undefined) {
    if (previous !== abs) fail(`${rel} would come from both ${previous} and ${abs}`);
    return;
  }
  written.set(rel, abs);
  const dest = join(out, rel);
  mkdirSync(dirname(dest), { recursive: true });
  copyFileSync(abs, dest);
}

/** The package root (folder with package.json, inside a node_modules) holding `abs`. */
function packageRootOf(abs: string): string | null {
  for (let dir = dirname(abs); dir.includes(`${sep}node_modules${sep}`); dir = dirname(dir)) {
    const parent = basename(dirname(dir));
    const scoped = parent.startsWith("@") && basename(dirname(dirname(dir))) === "node_modules";
    if ((parent === "node_modules" || scoped) && existsSync(join(dir, "package.json"))) return dir;
  }
  return null;
}

/** Every package that had a file copied gets its package.json and licence files too. */
function copyPackageMeta(root: string): void {
  copyIntoPack(join(root, "package.json"));
  for (const name of readdirSync(root)) {
    if (LICENCE_FILE.test(name) && statSync(join(root, name)).isFile()) copyIntoPack(join(root, name));
  }
}

function filesUnder(dir: string): string[] {
  const outFiles: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== "node_modules") outFiles.push(...filesUnder(p));
    } else if (entry.isFile()) {
      outFiles.push(p);
    }
  }
  return outFiles;
}

// ---- 0. a clean output folder ----------------------------------------------------
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

// ---- 1. the bundle ----------------------------------------------------------------
const cliPackage = packageDir(engineDir, "@remotion/cli");
const cli = join(cliPackage, "remotion-cli.js");
log("bundling the engine (remotion bundle)…");
const bundled = spawnSync(process.execPath, [cli, "bundle", `--out-dir=${join(out, "bundle")}`], {
  cwd: engineDir,
  stdio: ["ignore", "ignore", "inherit"],
});
if (bundled.status !== 0) fail(`remotion bundle exited ${String(bundled.status)}`);
for (const file of filesUnder(join(out, "bundle"))) {
  if (file.endsWith(".map") && basename(file) !== KEPT_SOURCE_MAP) rmSync(file);
}
const bundleHash = createHash("sha256");
for (const file of filesUnder(join(out, "bundle")).sort()) {
  bundleHash.update(relative(join(out, "bundle"), file));
  bundleHash.update("\0");
  bundleHash.update(readFileSync(file));
  bundleHash.update("\0");
}
const bundleKey = bundleHash.digest("hex");

// ---- 2. the renderer and its runtime dependencies ---------------------------------
const seen = new Set<string>();
const queue: Array<{ from: string; name: string }> = [{ from: engineDir, name: RENDERER_PACKAGE }];
while (queue.length > 0) {
  const next = queue.shift();
  if (next === undefined) break;
  const dir = packageDir(next.from, next.name);
  if (seen.has(dir)) continue;
  seen.add(dir);
  for (const file of filesUnder(dir)) copyIntoPack(file);
  const manifest = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as {
    dependencies?: Record<string, string>;
    peerDependencies?: Record<string, string>;
    peerDependenciesMeta?: Record<string, { optional?: boolean }>;
  };
  // A required peer (remotion → react, react-dom) is loaded at run time too.
  const peers = Object.keys(manifest.peerDependencies ?? {}).filter(
    (p) => manifest.peerDependenciesMeta?.[p]?.optional !== true,
  );
  for (const dep of [...Object.keys(manifest.dependencies ?? {}), ...peers]) {
    if (!dep.startsWith(DOWNLOADED_PREFIX)) queue.push({ from: dir, name: dep });
  }
}
log(`renderer: ${seen.size} packages`);

// ---- 3. the component check: its own sources, TypeScript, and the types it reads ----
const checkScript = join(engineDir, "scripts", "check-component.mts");
const scriptProgram = ts.createProgram({
  rootNames: [checkScript, join(engineDir, "scripts", "render.mts")],
  options: {
    noEmit: true,
    allowImportingTsExtensions: true,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    target: ts.ScriptTarget.ES2022,
    skipLibCheck: true,
    types: [],
  },
});
for (const sf of scriptProgram.getSourceFiles()) {
  const file = resolve(sf.fileName);
  if (!file.includes(`${sep}node_modules${sep}`) && file.startsWith(engineDir)) copyIntoPack(file);
}

const tsDir = packageDir(engineDir, "typescript");
for (const f of TYPESCRIPT_FILES) copyIntoPack(join(tsDir, f));
for (const f of readdirSync(join(tsDir, "lib"))) {
  if (/^lib\..*\.d\.ts$/.test(f)) copyIntoPack(join(tsDir, "lib", f));
}
copyPackageMeta(tsDir);

// What the strict type-check of a component reads: a program importing every
// allowed module, from where the check places a component.
const probe = join(engineDir, "src", "custom", "__check__", "Component.tsx");
const probeSource = `${ALLOWED_COMPONENT_IMPORTS.map((m, i) => `import * as m${i} from "${m}";`).join("\n")}
export default function C() { return null; }
${ALLOWED_COMPONENT_IMPORTS.map((_, i) => `void m${i};`).join("\n")}
`;
const checkOptions: ts.CompilerOptions = {
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
  paths: { "@apelles/component": [join(engineDir, "src", "custom", "componentApi.ts")] },
};
const host = ts.createCompilerHost(checkOptions, true);
const read = new Set<string>();
const probeFile = ts.createSourceFile(probe, probeSource, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TSX);
const baseGet = host.getSourceFile.bind(host);
host.getSourceFile = (name, version, onError, create) =>
  resolve(name) === probe ? probeFile : baseGet(name, version, onError, create);
const baseExists = host.fileExists.bind(host);
host.fileExists = (name) => resolve(name) === probe || baseExists(name);
const baseRead = host.readFile.bind(host);
host.readFile = (name) => {
  if (resolve(name) === probe) return probeSource;
  const text = baseRead(name);
  if (text !== undefined) read.add(resolve(name));
  return text;
};
const typeProgram = ts.createProgram({ rootNames: [probe], options: checkOptions, host });
const diagnostics = typeProgram.getSemanticDiagnostics(probeFile);
if (diagnostics.length > 0) {
  fail(`the allowlist does not type-check: ${ts.flattenDiagnosticMessageText(diagnostics[0].messageText, "\n")}`);
}
for (const sf of typeProgram.getSourceFiles()) read.add(resolve(sf.fileName));
read.delete(probe);
const typeRoots = new Set<string>();
for (const file of read) {
  copyIntoPack(file);
  const root = packageRootOf(file);
  if (root !== null) typeRoots.add(root);
}
for (const root of typeRoots) copyPackageMeta(root);
for (const dir of seen) copyPackageMeta(dir);
log(`component check: ${read.size} files read, ${typeRoots.size} packages`);

// ---- 4. built-in components, package.json, pack.json -------------------------------
cpSync(join(engineDir, "components"), join(out, "components"), { recursive: true });
const engineManifest = JSON.parse(readFileSync(join(engineDir, "package.json"), "utf8")) as {
  version: string;
  dependencies: Record<string, string>;
};
writeFileSync(
  join(out, "package.json"),
  `${JSON.stringify({ name: "@apelles/motion-engine-pack", version: engineManifest.version, private: true, license: "UNLICENSED" }, null, 2)}\n`,
);
const pack = {
  formatVersion: 1,
  remotionVersion: engineManifest.dependencies.remotion,
  bundleKey,
};
writeFileSync(join(out, "pack.json"), `${JSON.stringify(pack, null, 2)}\n`);

// ---- 5. self-test from outside the repository --------------------------------------
const scratch = mkdtempSync(join(tmpdir(), "apelles-pack-selftest-"));
try {
  const copy = join(scratch, "motion-engine");
  cpSync(out, copy, { recursive: true });
  const loads = spawnSync(process.execPath, ["--input-type=module", "-e", `await import("${RENDERER_PACKAGE}");`], {
    cwd: copy,
    encoding: "utf8",
  });
  if (loads.status !== 0) fail(`the pack's ${RENDERER_PACKAGE} does not load:\n${loads.stderr}`);
  let checked = 0;
  for (const id of readdirSync(join(copy, "components"))) {
    for (const version of readdirSync(join(copy, "components", id))) {
      const dir = join(copy, "components", id, version);
      const source = readFileSync(join(dir, "component.tsx"), "utf8");
      const run = spawnSync(
        process.execPath,
        ["--disable-warning=MODULE_TYPELESS_PACKAGE_JSON", join(copy, "scripts", "check-component.mts")],
        { cwd: copy, input: JSON.stringify({ source }), encoding: "utf8" },
      );
      if (run.status !== 0) fail(`the pack's component check crashed on ${id}@${version}:\n${run.stderr}`);
      const result = JSON.parse(run.stdout) as { ok: boolean; code?: string; issues: unknown[] };
      if (!result.ok) fail(`${id}@${version} fails the pack's component check: ${JSON.stringify(result.issues)}`);
      if (result.code !== readFileSync(join(dir, "component.js"), "utf8")) {
        fail(`${id}@${version} compiles to a different module in the pack`);
      }
      checked += 1;
    }
  }
  log(`self-test: renderer loads; ${checked} built-in components pass the check with their certified modules`);
} finally {
  rmSync(scratch, { recursive: true, force: true });
}

const bytes = filesUnder(out).reduce((sum, f) => sum + statSync(f).size, 0);
log(`wrote ${out}: ${written.size} files + the bundle, ${(bytes / 1048576).toFixed(1)} MB, bundleKey ${bundleKey.slice(0, 16)}`);
