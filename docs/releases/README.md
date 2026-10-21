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
   the check).
5. Commit, then `git tag -a v<version> -m "Apelles <version>"` and
   `git push origin main v<version>`.

## What the workflow checks and attaches

It fails if the tag and `package.json` disagree, if the notes are missing, if
the bundle's signature does not verify, if any bundled binary is missing, if
the shipped MCP server still carries `motion_*` tools (D-391), or if the
bundle's `CFBundleShortVersionString` is not the version. It attaches the DMG,
the FFmpeg source tarball the bundled GPL build obliges us to offer (D-389),
and `SHA256SUMS.txt`.

## If a run fails

Fix the cause on `main`, then move the tag to the fixed commit and push it
again (`git tag -f -a v<version> …` and `git push -f origin v<version>`),
deleting any half-made release first (`gh release delete v<version>`).
