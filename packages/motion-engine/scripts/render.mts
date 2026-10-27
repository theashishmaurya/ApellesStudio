/**
 * render.mts — the one Remotion render entry point the app runs (D-417).
 *
 * What it is: a small Node program over `@remotion/renderer`'s public API that
 * renders a prebuilt engine BUNDLE (a `remotion bundle` output folder) to a
 * still PNG, an image sequence, or a video. `apelles_motion` spawns it as
 * `node scripts/render.mts <still|frames|video> --serve-url=<bundle> …` for
 * every Motion render path: the scene export (D-180/D-398), the preview still
 * (D-403), the custom-component proof and proxy frames (D-409).
 *
 * Why not the `remotion` CLI any more: the CLI eagerly loads the bundler and
 * the Studio (hundreds of MB of dependencies), so it cannot run from the small
 * engine pack the release app ships (D-417). This script needs only
 * `@remotion/renderer`. It is used in development too, so the render path a
 * developer exercises is the one a user runs.
 *
 * Render settings that used to come from `remotion.config.ts` (which only the
 * CLI reads) are the named constants below and are applied here, explicitly:
 * the ANGLE GL backend, JPEG frames for video, and the D-342 2x scale for a
 * video whose caller gives none. `remotion.config.ts` keeps them for Studio.
 *
 * Determinism: nothing here reads the clock or randomness; the output depends
 * only on the bundle, the props file, the frame(s) and the scale.
 *
 * What it does NOT do: bundle (the caller passes a bundle), validate the
 * manifest (the app's zod schema does), or download a browser — the app passes
 * `--browser-executable` when it manages Chrome Headless Shell itself, and in
 * a developer checkout Remotion's own `ensureBrowser` cache is used.
 *
 * Exit status: 0 on success (one JSON line on stdout), 1 on a render error
 * (message on stderr), 2 on bad arguments.
 */
import { readFileSync } from "node:fs";
import { extname } from "node:path";
import { parseArgs } from "node:util";
import {
  ensureBrowser,
  openBrowser,
  renderFrames,
  renderMedia,
  renderStill,
  selectComposition,
  type ChromiumOptions,
  type Codec,
} from "@remotion/renderer";

/** `Config.setChromiumOpenGlRenderer("angle")` in `remotion.config.ts`. */
const CHROMIUM_OPTIONS: ChromiumOptions = { gl: "angle" };
/** `Config.setVideoImageFormat("jpeg")`: the frame format a video is encoded from. */
const VIDEO_FRAME_FORMAT = "jpeg" as const;
/** `Config.setScale(2)` (D-342): a video renders at 2x its authored size unless told otherwise. */
const DEFAULT_VIDEO_SCALE = 2;
/** The one composition a manifest renders through. */
const DEFAULT_COMPOSITION = "Animation";
/** The CLI's `--sequence` file names (`element-042.png`); `apelles_motion::still::sequence_frames` reads them. */
const SEQUENCE_PATTERN = "element-[frame].[ext]";

function fail(code: number, message: string): never {
  process.stderr.write(`render.mts: ${message}\n`);
  process.exit(code);
}

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    "serve-url": { type: "string" },
    composition: { type: "string" },
    output: { type: "string" },
    props: { type: "string" },
    frame: { type: "string" },
    frames: { type: "string" },
    scale: { type: "string" },
    concurrency: { type: "string" },
    port: { type: "string" },
    "browser-executable": { type: "string" },
    "binaries-directory": { type: "string" },
  },
});

const mode = positionals[0];
if (mode !== "still" && mode !== "frames" && mode !== "video") {
  fail(2, `expected a mode (still | frames | video), got ${String(mode)}`);
}

function required(name: "serve-url" | "output" | "props"): string {
  const v = values[name];
  if (typeof v !== "string" || v === "") fail(2, `--${name} is required`);
  return v;
}

function integer(name: string, raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) fail(2, `--${name} must be a non-negative integer, got ${raw}`);
  return n;
}

function frameRange(raw: string | undefined): [number, number] | null {
  if (raw === undefined) return null;
  const m = /^(\d+)-(\d+)$/.exec(raw);
  if (!m) fail(2, `--frames must be <start>-<end>, got ${raw}`);
  return [Number(m[1]), Number(m[2])];
}

/** The codec a video's file extension asks for — the CLI's own mapping for the two the app writes. */
function codecFor(output: string): Codec {
  const ext = extname(output).toLowerCase();
  if (ext === ".mp4" || ext === ".mkv") return "h264";
  if (ext === ".mov") return "prores";
  return fail(2, `cannot pick a codec for ${output} (expected .mp4, .mkv or .mov)`);
}

const serveUrl = required("serve-url");
const output = required("output");
const inputProps = JSON.parse(readFileSync(required("props"), "utf8")) as Record<string, unknown>;
const id = values.composition ?? DEFAULT_COMPOSITION;
const port = integer("port", values.port) ?? null;
const browserExecutable = values["browser-executable"] ?? null;
const binariesDirectory = values["binaries-directory"] ?? null;
const scaleArg = values.scale === undefined ? undefined : Number(values.scale);
if (scaleArg !== undefined && !(scaleArg > 0)) fail(2, `--scale must be positive, got ${values.scale}`);
const scale = scaleArg ?? (mode === "video" ? DEFAULT_VIDEO_SCALE : 1);
const concurrency = integer("concurrency", values.concurrency) ?? null;

// With an executable given this only checks it exists; without one (a developer
// checkout) it is Remotion's own cached Chrome Headless Shell, as the CLI used.
await ensureBrowser({ browserExecutable, logLevel: "error" });

// One browser for selecting and rendering, opened at the render's device scale —
// what the CLI does, so a still renders exactly as `remotion still` rendered it.
const browser = await openBrowser("chrome", {
  browserExecutable,
  chromiumOptions: CHROMIUM_OPTIONS,
  forceDeviceScaleFactor: scale,
  logLevel: "error",
});

try {
  const common = {
    serveUrl,
    inputProps,
    browserExecutable,
    chromiumOptions: CHROMIUM_OPTIONS,
    port,
    puppeteerInstance: browser,
    binariesDirectory,
    logLevel: "error" as const,
  };
  const composition = await selectComposition({ ...common, id });

  if (mode === "still") {
    await renderStill({
      ...common,
      composition,
      output,
      frame: integer("frame", values.frame) ?? 0,
      imageFormat: "png",
      scale,
      overwrite: true,
    });
  } else if (mode === "frames") {
    await renderFrames({
      ...common,
      composition,
      outputDir: output,
      imageFormat: "png",
      imageSequencePattern: SEQUENCE_PATTERN,
      frameRange: frameRange(values.frames),
      scale,
      concurrency,
      onStart: () => undefined,
      onFrameUpdate: () => undefined,
    });
  } else {
    await renderMedia({
      ...common,
      composition,
      outputLocation: output,
      codec: codecFor(output),
      imageFormat: VIDEO_FRAME_FORMAT,
      frameRange: frameRange(values.frames),
      scale,
      concurrency,
      overwrite: true,
    });
  }
  process.stdout.write(`${JSON.stringify({ ok: true, mode, output })}\n`);
} catch (e) {
  process.stderr.write(`${e instanceof Error ? (e.stack ?? e.message) : String(e)}\n`);
  process.exitCode = 1;
} finally {
  // A render that failed may already have lost its page; closing is best effort
  // and must not replace the real error with "Target closed".
  await browser.close({ silent: true }).catch(() => undefined);
}
