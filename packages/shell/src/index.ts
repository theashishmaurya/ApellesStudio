/**
 * @apelles/shell — the Apelles app shell (D-039).
 *
 * The 3-tab layout (Edit / Motion / Colorist): a title bar (window chrome +
 * tabs) + the active tab's content, a persisted tab store, and Cmd/Ctrl+1/2/3
 * switching. Tab content is passed in via the `tabs` registry prop so the shell
 * never imports the colorist app or the tab packages.
 *
 * Window chrome (the traffic lights / window controls / drag region, ported
 * from RapidRAW's `TitleBar`) lives here now too — `WindowChrome.tsx`.
 *
 * D-039 step 6c: the project launcher (D-037) is the shell's entry screen —
 * `<Shell projectOpen={false} launcher={...}>` renders it full-window with no
 * tabs. The shell still doesn't import `ProjectLauncher` (app → shell only); it
 * arrives via the `launcher` prop.
 *
 * D-251, shell-level since D-297: `Shell` takes a `headerAction` node,
 * rendered in the chrome bar's own right-hand cluster (beside the window
 * controls) whenever a project is open — on every tab. It is the Export
 * trigger/dialog (`@apelles/editor`'s `EditorExportDialog`), the app's ONE
 * export surface since D-297 retired Colorist's own, and it arrives via the
 * same injection pattern as `launcher`. D-251 had it as a per-tab
 * `ShellTab.headerAction`; see `Shell.tsx`'s own module doc ("Chrome-bar
 * action") for why it stopped being per-tab and why neither shape reopens the
 * `@apelles/editor`-free dependency boundary this file describes above.
 */

export { Shell, type ShellTab, type ShellProps } from './Shell';
export { useShellStore, useActiveTab, type ShellTabId } from './store';
export { useWindowChrome, MacTrafficLights, WindowControls } from './WindowChrome';
