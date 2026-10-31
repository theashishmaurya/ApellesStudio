/**
 * fixture.ts — the harness's own media, project and per-scenario timelines (D-434).
 *
 * What it is: everything that keeps a harness run OFF the owner's work.
 *   - `ensureMedia` generates three small test files with ffmpeg (`testsrc2`
 *     picture only, the same picture with a tone, and a tone alone) into the
 *     run's scratch directory, once.
 *   - `openScratchProject` remembers which project the app had open, creates a
 *     brand-new `ui-harness-<stamp>` project from that media, and waits until
 *     the Edit tab has really switched to it; `restore` reopens the original
 *     and deletes the scratch project's folder (only a folder this run created,
 *     named `ui-harness-*.chroma`).
 *   - `buildFixture` creates one fresh timeline per scenario inside the scratch
 *     project, lays out the scenario's tracks / clips / markers through the
 *     same `editor_*` ops an agent uses, and maps the fixture's clip NAMES to
 *     the ids the app assigned; `teardownFixture` deletes that timeline.
 *
 * What it does NOT do: touch any project but the one it created, or leave the
 *   app on it — every path out of a run goes through `restore`.
 */

import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { basename, join } from 'node:path';
import { promisify } from 'node:util';

import type { OpClient } from './client.ts';
import type { FixtureSpec, MediaKind } from './scenario.ts';
import { timelineSnapshot } from './snapshot.ts';

const run = promisify(execFile);

/** Test media: long enough for every trim/slip/slide to have handles. */
export const MEDIA_SECONDS = 30;
export const MEDIA_FPS = 30;
const MEDIA_SIZE = '1280x720';
/** How long to wait for the app to finish switching projects. */
const PROJECT_SWITCH_TIMEOUT_MS = 30_000;
const POLL_MS = 250;

export type MediaFiles = Record<MediaKind, string>;

/** The ffmpeg arguments for one test file — pure, so it is unit-tested. */
export function mediaArgs(kind: MediaKind, out: string): string[] {
  const picture = ['-f', 'lavfi', '-i', `testsrc2=size=${MEDIA_SIZE}:rate=${MEDIA_FPS}:duration=${MEDIA_SECONDS}`];
  const tone = ['-f', 'lavfi', '-i', `sine=frequency=440:sample_rate=48000:duration=${MEDIA_SECONDS}`];
  const h264 = ['-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-g', String(MEDIA_FPS)];
  switch (kind) {
    case 'video':
      return ['-y', ...picture, ...h264, '-an', out];
    case 'av':
      return ['-y', ...picture, ...tone, ...h264, '-c:a', 'aac', '-shortest', out];
    case 'tone':
      return ['-y', ...tone, '-c:a', 'pcm_s16le', out];
  }
}

export async function ensureMedia(dir: string, ffmpeg = 'ffmpeg'): Promise<MediaFiles> {
  mkdirSync(dir, { recursive: true });
  const files: MediaFiles = {
    video: join(dir, `harness-video-${MEDIA_SECONDS}s.mp4`),
    av: join(dir, `harness-av-${MEDIA_SECONDS}s.mp4`),
    tone: join(dir, `harness-tone-${MEDIA_SECONDS}s.wav`),
  };
  for (const kind of Object.keys(files) as MediaKind[]) {
    if (!existsSync(files[kind])) await run(ffmpeg, mediaArgs(kind, files[kind]));
  }
  return files;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

interface EditorState {
  openProject: string | null;
  status: string;
  activeTimeline: { id: string; fps: number } | null;
}

export interface ScratchProject {
  path: string;
  /** media kind → the pool item id the app gave it. */
  mediaIds: Record<MediaKind, string>;
  originalProject: string | null;
}

/** Create and open a fresh project holding the test media. */
export async function openScratchProject(client: OpClient, media: MediaFiles, stamp: string): Promise<ScratchProject> {
  const before = await client.op<EditorState>('editor_get_state');
  const created = await client.op<{ created: { path: string } }>('new_project', {
    name: `ui-harness-${stamp}`,
    media_paths: Object.values(media),
  });
  const path = created.created.path;
  const deadline = Date.now() + PROJECT_SWITCH_TIMEOUT_MS;
  for (;;) {
    const st = await client.op<EditorState>('editor_get_state');
    if (st.openProject === path && st.status === 'ready') break;
    if (Date.now() > deadline) throw new Error(`the app did not switch to the scratch project within ${PROJECT_SWITCH_TIMEOUT_MS} ms (still on ${st.openProject}, ${st.status})`);
    await sleep(POLL_MS);
  }
  // `new_project` puts the media in the pool; importing again returns the ids
  // (a path already in the pool is returned, not duplicated).
  const imported = await client.op<{ added?: { id: string; sourcePath: string }[] }>('editor_import_media', {
    paths: Object.values(media),
  });
  const pool = await client.op<{ items?: { id: string; sourcePath: string }[] }>('editor_list_media');
  const items = [...(imported.added ?? []), ...(pool.items ?? [])];
  const mediaIds = {} as Record<MediaKind, string>;
  for (const kind of Object.keys(media) as MediaKind[]) {
    const item = items.find((m) => m.sourcePath === media[kind]);
    if (!item) throw new Error(`the scratch project's media pool has no item for ${media[kind]}`);
    mediaIds[kind] = item.id;
  }
  return { path, mediaIds, originalProject: before.openProject };
}

/** Reopen what the app had before, and delete the scratch project folder. */
export async function restore(client: OpClient, project: ScratchProject, opts: { keep: boolean }): Promise<string[]> {
  const notes: string[] = [];
  if (project.originalProject) {
    try {
      await client.op('open_project', { path: project.originalProject });
    } catch (e) {
      notes.push(`could not reopen ${project.originalProject}: ${String((e as Error).message)}`);
    }
  }
  const name = basename(project.path);
  if (!opts.keep && /^ui-harness-.*\.chroma$/.test(name) && existsSync(project.path)) {
    rmSync(project.path, { recursive: true, force: true });
    notes.push(`deleted the scratch project ${project.path}`);
  } else if (opts.keep) {
    notes.push(`kept the scratch project ${project.path}`);
  }
  return notes;
}

export interface BuiltFixture {
  timelineId: string;
  /** clip id → fixture name, and marker id → fixture name. */
  clipNames: Record<string, string>;
  markerNames: Record<string, string>;
  /** fixture name → id (the reverse, for `@clip:name` substitution). */
  clipIds: Record<string, string>;
  markerIds: Record<string, string>;
}

interface TrackDto {
  index: number;
  kind: string;
}

export async function buildFixture(client: OpClient, project: ScratchProject, scenarioId: string, spec: FixtureSpec | undefined): Promise<BuiltFixture> {
  const created = await client.op<{ timeline: { id: string } }>('editor_create_timeline', { name: `ui-harness ${scenarioId}`, activate: true });
  const timelineId = created.timeline.id;
  const built: BuiltFixture = { timelineId, clipNames: {}, markerNames: {}, clipIds: {}, markerIds: {} };
  if (!spec) return built;

  // Tracks, top to bottom: insert any the new timeline lacks at its index.
  for (const [i, track] of spec.tracks.entries()) {
    const listed = await client.op<{ tracks: TrackDto[] }>('editor_list_tracks');
    if (listed.tracks[i]?.kind !== track.kind) await client.op('editor_add_track', { trackKind: track.kind, index: i });
  }
  for (const [i, track] of spec.tracks.entries()) {
    for (const c of track.clips) {
      await client.op('editor_add_clip', {
        track: i,
        ripple: false,
        mediaId: project.mediaIds[c.media ?? 'video'],
        sourceStart: c.sourceStart ?? 0,
        duration: c.duration,
        startFrame: c.startFrame,
      });
    }
  }
  const snap = timelineSnapshot(await client.op('editor_get_timeline'));
  for (const [i, track] of spec.tracks.entries()) {
    for (const c of track.clips) {
      const placed = snap.tracks[i]?.find((s) => s.startFrame === c.startFrame && !built.clipNames[s.id]);
      if (!placed) throw new Error(`fixture clip "${c.name}" did not land at frame ${c.startFrame} on track ${i}`);
      built.clipNames[placed.id] = c.name;
      built.clipIds[c.name] = placed.id;
    }
  }
  for (const m of spec.markers ?? []) {
    await client.op('editor_add_marker', { frame: m.frame, name: m.name });
  }
  if (spec.markers?.length) {
    const listed = await client.op<{ markers: { id: string; name: string | null }[] }>('editor_list_markers');
    for (const m of spec.markers) {
      const found = listed.markers.find((x) => x.name === m.name);
      if (found) {
        built.markerNames[found.id] = m.name;
        built.markerIds[m.name] = found.id;
      }
    }
  }
  await client.op('editor_set_playhead', { frame: spec.playhead ?? 0 });
  return built;
}

export async function teardownFixture(client: OpClient, built: BuiltFixture): Promise<void> {
  await client.op('editor_set_playing', { playing: false }).catch(() => undefined);
  await client.op('editor_delete_timeline', { id: built.timelineId });
}

/** The run's output directory layout. */
export function runDirs(root: string, stamp: string) {
  const run = join(root, 'runs', stamp);
  return { media: join(root, 'media'), run, shots: join(run, 'shots') };
}
