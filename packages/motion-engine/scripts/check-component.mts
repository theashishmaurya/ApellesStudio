/**
 * check-component.mts — the Node entry point of a custom component's static
 * check (D-409).
 *
 * What it is: reads `{"source": "<tsx>"}` as JSON on stdin, runs
 * `checkComponentSource` (`../src/custom/sourceCheck.ts`: allowlisted imports,
 * the AST ban list, a strict type-check against this package's real types),
 * and writes the result — `{ok, issues, warnings, code?}` — as JSON on stdout.
 * `apelles_motion::components::check_source` spawns it as
 * `node scripts/check-component.mts` with this package as the working
 * directory; Node runs the TypeScript directly (type stripping, Node 22.18+).
 *
 * Exit status: 0 whenever a result was written (a source that FAILS the check
 * is still a successful run, `ok: false`); 2 when the input itself is
 * unreadable; anything else is a crash the caller reports with its stderr.
 *
 * What it does NOT do: write files, render, or certify.
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { checkComponentSource } from "../src/custom/sourceCheck.ts";

const engineDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");

let input: unknown;
try {
  input = JSON.parse(readFileSync(0, "utf8"));
} catch (e) {
  process.stderr.write(`check-component: stdin is not JSON: ${String(e)}\n`);
  process.exit(2);
}
const source = typeof input === "object" && input !== null ? (input as { source?: unknown }).source : undefined;
if (typeof source !== "string") {
  process.stderr.write('check-component: expected {"source": "<tsx>"} on stdin\n');
  process.exit(2);
}
process.stdout.write(`${JSON.stringify(checkComponentSource(source, engineDir))}\n`);
