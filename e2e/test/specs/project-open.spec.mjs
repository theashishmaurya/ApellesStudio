// D-104 — the first real E2E test, and a direct regression test for B-030
// (the project-open bug found live tonight: `open_manifest` resolved the
// active clip against a raw, non-deduplicated clip-path list instead of the
// decode session's own deduplicated shot list, so a project with two clips
// sharing a source path — now a real, common shape after this session's
// multi-track NLE work — threw "shot index out of range" deep inside
// `chroma_project_open`, before `state::set_project` ever ran, and the
// launcher silently never transitioned to the tab view. No amount of
// Chromium-harness or synthetic-event testing could have caught this — it
// only reproduced against the real native window, which is the entire
// reason this E2E harness exists.
describe('project launcher', () => {
  it('opens a project and shows the tab view', async () => {
    // The launcher renders "Welcome to Chroma" full-window until a project
    // is open (Shell.tsx, D-039) — a real signal this test starts from the
    // right screen, not mid-project from a previous run's leftover state.
    const heading = await $('h1=Welcome to Chroma');
    await heading.waitForDisplayed({ timeout: 15000 });

    // The first real project card — a <button title="<path>"> per
    // ProjectLauncher.tsx's ProjectCard. Whatever project data exists on
    // this machine; this test doesn't assume a specific name, only that at
    // least one real project is present (true for this repo's own dev
    // setup — see docs/notes/e2e-testing.md if this ever needs a dedicated
    // fixture project instead of relying on ambient state).
    const projectCard = await $('button[title]');
    await projectCard.waitForDisplayed({ timeout: 10000 });
    await projectCard.click();

    // The regression: before the B-030 fix, this never happened — the
    // click's own async chain (chroma_project_open -> session_set_active)
    // threw inside the Rust command before state::set_project ran, so the
    // launcher stayed up forever with no visible error. Shell.tsx only
    // renders the tab bar (role="tablist") once `projectOpen` is true.
    const tabs = await $('[role="tablist"]');
    await tabs.waitForDisplayed({ timeout: 15000 });

    const editTab = await $('button[role="tab"]=Edit');
    await expect(editTab).toBeDisplayed();
  });
});
