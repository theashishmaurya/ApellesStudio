// Apelles — the full-window project-open loader (B-369).
//
// What it is: `@apelles/ui`'s `BrandedLoader` over the whole window while a
// project opens and the workspace is already mounted (the second half of an open
// started from the launcher, or any open/new from inside a project, the GUI's or
// an agent's `open_project`). While the launcher is still on screen the clicked
// card carries the same loader instead (`ProjectLauncher`'s `ProjectCard`), so
// the two hand over without a blank frame.
//
// What it does NOT do: track the open. `useOpenProgressStore` does; this reads
// its view and renders nothing when no open is under way.

import { BrandedLoader } from '@apelles/ui';

import { openProgressView } from '../../store/openProgress';
import { useOpenProgressStore } from '../../store/useOpenProgressStore';
import { useSessionStore } from '../../store/useSessionStore';

/** Above the shell's panels and popovers, below toasts (react-toastify sits at 9999). */
const OVERLAY_Z = 'z-[9000]';

export default function ProjectOpenOverlay() {
  const active = useOpenProgressStore((s) => s.active);
  const phase = useOpenProgressStore((s) => s.phase);
  const done = useOpenProgressStore((s) => s.done);
  const total = useOpenProgressStore((s) => s.total);
  const kind = useOpenProgressStore((s) => s.kind);
  const projectName = useOpenProgressStore((s) => s.projectName);
  const workspaceShown = useSessionStore((s) => !!s.projectPath || !!s.projectName);
  if (!active || !workspaceShown) return null;
  const view = openProgressView({ openId: 0, active, kind, projectName, phase, done, total });
  if (!view) return null;
  return (
    <div className={`fixed inset-0 ${OVERLAY_Z}`} data-testid="project-open-overlay">
      <BrandedLoader variant="overlay" title={projectName ?? undefined} label={view.label} progress={view.fraction} />
    </div>
  );
}
