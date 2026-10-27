# Releases

A release is cut by pushing a version tag. `.github/workflows/release.yml`
(D-392) builds the DMG on a GitHub macOS (Apple Silicon) runner and publishes
the GitHub Release. This file is the checklist around it.

## Before tagging

1. Bump `"version"` in the root `package.json` (and `package-lock.json`'s two
   root entries). The app bundle takes its version from there (D-388).
2. Write `docs/releases/v<version>.md`: the release notes, used verbatim as
   the GitHub Release body. The workflow refuses to run without it.
3. In `docs/CHANGELOG.md`, turn `[Unreleased]` into `[<version>] — <date>`
   and open a fresh `[Unreleased]` above it.
4. Run the checks the hosted runner cannot (parts need a GPU or the live app):
   `cargo test --workspace`, `npm test`, and `tsc` in `app/` at no more than
   its known baseline. Then a local `npm run tauri:build` and an install of
   the DMG from a quarantined copy (`docs/notes/` / the B-254 entry describe
   the check), including the Motion runtime steps below.
5. **Motion runtime (D-417).** The DMG does not carry Node.js or Chrome
   Headless Shell; the installed app downloads them. Before tagging:
   - The pinned downloads still exist and still match:
     `cargo run -p apelles-motion-runtime --example install_runtime -- /tmp/rt-check`
     (real network; prints sizes, timings and "integrity check: ready").
   - The real renders reproduce their recorded hashes on that runtime:
     `APELLES_MOTION_RUNTIME_DIR=/tmp/rt-check/<key> APELLES_MOTION_PACK_DIR=$PWD/app/src-tauri/motion-engine-pack cargo test -p apelles-motion --test preview_render --test component_render -- --ignored`
     (the release configuration: the staged engine pack with the downloaded runtime).
   - On the installed, quarantined build, with no runtime yet
     (`rm -rf ~/Library/Application\ Support/studio.apelles.app/motion-runtime`):
     open a project, open the Motion tab. The banner starts the download by
     itself with a progress bar; editing works meanwhile; Render and Still are
     disabled with the reason. When it finishes the banner disappears; press
     Still, then Render, and check both outputs. Write a custom component and
     run its check (Catalog › Custom › New component › Check).
   - Offline: Settings › Motion Runtime › Remove; turn Wi-Fi off; press
     Download in the Motion tab's banner (the automatic download runs once per
     launch): it says "no internet connection" with Retry. Turn Wi-Fi on,
     Retry: it finishes. Pull the network part-way through a download and
     Retry: it resumes from the partial file.
   - Quit and relaunch: the app log has `[motion-runtime] Ready` from the
     launch integrity check, and nothing downloads again.
   - Ask the MCP client for `motion_runtime_status` (expect `"state": "ready"`,
     `"source": "managed"`).
6. Commit, then `git tag -a v<version> -m "Apelles <version>"` and
   `git push origin main v<version>`.

## What the workflow checks and attaches

It fails if the tag and `package.json` disagree, if the notes are missing, if
the bundle's signature does not verify, if any bundled binary is missing, if
the Motion engine pack or its notice is missing from Resources (D-417), if the
shipped MCP server lacks its `motion_*` tools (D-417 lifted D-391's hide), or if
the bundle's `CFBundleShortVersionString` is not the version. It attaches the DMG,
the FFmpeg source tarball the bundled GPL build obliges us to offer (D-389),
and `SHA256SUMS.txt`.

## If a run fails

Fix the cause on `main`, then move the tag to the fixed commit and push it
again (`git tag -f -a v<version> …` and `git push -f origin v<version>`),
deleting any half-made release first (`gh release delete v<version>`).
