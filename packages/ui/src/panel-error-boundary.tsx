/**
 * @apelles/ui — `PanelErrorBoundary`: one panel's render crash stays in that
 * panel (B-292).
 *
 * **What it is:** React's canonical error boundary (a class component with
 * `getDerivedStateFromError` + `componentDidCatch` — the one thing a function
 * component cannot be), wrapped around each tab and each major pane: the
 * timeline, the preview, the Inspector, the Motion and Colorist panes, the
 * library column. A throw while rendering (or in a layout/passive effect of)
 * anything inside it replaces just that panel with a fallback that names the
 * panel, shows the error, and offers **Reload panel**; the rest of the window
 * keeps working.
 *
 * **Why:** with no boundary anywhere, React unmounts the WHOLE root on an
 * uncaught render error. On 2026-10-28 one throw in the timeline library
 * (B-291) left a blank white window, and every control-bridge op then timed
 * out ("op … timed out waiting for the frontend") until a manual reload,
 * because the op registries had been unmounted with everything else.
 *
 * **What it does:**
 * - logs the error and component stack with `console.error`, which the app
 *   forwards to its log as a `[frontend]` ERROR line (`frontendLogBridge`);
 * - records the crash in `panel-crashes.ts`, which the debug-only
 *   `debug_get_ui_state` reports as `crashedPanels`;
 * - on **Reload panel**, clears the crash and REMOUNTS the children (a fresh
 *   key), so a panel whose state is what broke starts clean. Children that own
 *   an op registry re-announce a new bridge claim on mount (B-272), so the
 *   bridge answers again without a page reload.
 *
 * **What it does NOT do:** catch errors in event handlers or async code (React
 * never routes those to a boundary; they do not unmount anything either), or
 * retry on its own — a panel that throws on every render would just loop.
 * Where a tab's op registry lives matters: each registry is mounted OUTSIDE
 * its tab's pane boundaries (`EditorTab`, `MotionTab` and the Colorist `App`
 * call their registry hook above the panes), so a crashed pane never takes
 * the bridge down with it. Only a crash in a tab's own top-level component
 * reaches the tab boundary, and that one does unmount the tab's registry
 * until the tab is reloaded.
 *
 * Hand-written rather than `react-error-boundary`: the whole need is the
 * ~40 lines below, and the dependency would bring nothing this does not
 * (CLAUDE.md's "a small, stable need has no business pulling in a
 * dependency"). D-418.
 */

import { Component, Fragment, type ErrorInfo, type ReactNode } from 'react';
import { ArrowClockwiseIcon, WarningCircleIcon } from '@phosphor-icons/react';

import { Button } from './components/ui/button';
import { clearPanelCrash, reportPanelCrash } from './panel-crashes';

export interface PanelErrorBoundaryProps {
  /** A human-readable name for the panel, shown in the fallback and used as
   *  its key in the crash registry ("Timeline", "tab:edit"). */
  panel: string;
  children: ReactNode;
  /** Extra classes for the fallback's root (it fills its parent by default). */
  fallbackClassName?: string;
}

interface PanelErrorBoundaryState {
  error: unknown;
  /** Bumped by Reload panel; keys the children so they remount from scratch. */
  epoch: number;
}

/** What a thrown value says about itself, whatever it is. */
function describe(error: unknown): { message: string; stack: string | null } {
  if (error instanceof Error) return { message: error.message || error.name, stack: error.stack ?? null };
  return { message: String(error), stack: null };
}

export class PanelErrorBoundary extends Component<PanelErrorBoundaryProps, PanelErrorBoundaryState> {
  state: PanelErrorBoundaryState = { error: null, epoch: 0 };

  static getDerivedStateFromError(error: unknown): Partial<PanelErrorBoundaryState> {
    // `null` would read as "no error"; a thrown `null`/`undefined` still crashed.
    return { error: error ?? new Error('a panel threw a non-error value') };
  }

  componentDidCatch(error: unknown, info: ErrorInfo): void {
    const { message, stack } = describe(error);
    const componentStack = info.componentStack ?? null;
    console.error(`[panel-crash] the ${this.props.panel} panel crashed: ${message}`, error, componentStack ?? '');
    reportPanelCrash({
      panel: this.props.panel,
      message,
      stack,
      componentStack,
      at: new Date().toISOString(),
    });
  }

  componentWillUnmount(): void {
    // A crashed panel that is unmounted (its tab closed, a project switched)
    // is no longer "down"; a clean one has nothing registered anyway.
    if (this.state.error !== null) clearPanelCrash(this.props.panel);
  }

  private readonly reload = (): void => {
    clearPanelCrash(this.props.panel);
    this.setState((s) => ({ error: null, epoch: s.epoch + 1 }));
  };

  render(): ReactNode {
    const { error, epoch } = this.state;
    if (error === null) return <Fragment key={epoch}>{this.props.children}</Fragment>;
    const { message } = describe(error);
    return (
      <div
        role="alert"
        data-panel-crash={this.props.panel}
        className={
          'flex h-full w-full min-h-0 flex-col items-center justify-center gap-2 bg-bg-primary p-4 text-center ' +
          (this.props.fallbackClassName ?? '')
        }
      >
        <WarningCircleIcon className="size-6 text-text-secondary" aria-hidden />
        <p className="text-sm text-text-primary">The {this.props.panel} panel crashed</p>
        <p className="max-w-md break-words font-mono text-xs text-text-secondary">{message}</p>
        <Button size="sm" variant="secondary" onClick={this.reload}>
          <ArrowClockwiseIcon aria-hidden />
          Reload panel
        </Button>
      </div>
    );
  }
}
