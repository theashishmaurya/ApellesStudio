/**
 * @chroma/shell — the Chroma app shell (D-039).
 *
 * The 3-tab layout (Edit / Motion / Colorist): a title bar (window chrome +
 * tabs) + the active tab's content, a persisted tab store, and Cmd/Ctrl+1/2/3
 * switching. Tab content is passed in via the `tabs` registry prop so the shell
 * never imports the colorist app or the tab packages.
 *
 * Window chrome (the traffic lights / window controls / drag region, ported
 * from RapidRAW's `TitleBar`) lives here now too — `WindowChrome.tsx`.
 *
 * Future (later D-039 steps): the project launcher (D-037) moves here from
 * inside the Colorist tab, since a project spans all three tabs.
 */

export { Shell, type ShellTab, type ShellProps } from './Shell';
export { useShellStore, useActiveTab, type ShellTabId } from './store';
export { useWindowChrome, MacTrafficLights, WindowControls } from './WindowChrome';
