/**
 * @chroma/shell — the Chroma app shell (D-039).
 *
 * The 3-tab layout (Edit / Motion / Colorist): a tab bar + the active tab's
 * content, a persisted tab store, and Cmd/Ctrl+1/2/3 switching. Tab content is
 * passed in via the `tabs` registry prop so the shell stays dependency-light
 * (react + zustand only) — it never imports the colorist app or the tab
 * packages.
 *
 * Future (later D-039 steps): the project launcher (D-037) moves here from
 * inside the Colorist tab, since a project spans all three tabs. Window chrome
 * (TitleBar) may move here too.
 */

export { Shell, type ShellTab, type ShellProps } from './Shell';
export { useShellStore, useActiveTab, type ShellTabId } from './store';
