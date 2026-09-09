// Apelles — per-project output spec (D-038).
//
// A small dialog for the loaded project's output resolution, frame rate and
// colour space — one spec for the whole (possibly multi-shot) project instead
// of everything being derived from whichever clip is loaded. Every field is
// optional: "Match first clip" clears it back to clip-derived, which is the
// pre-D-038 behaviour everywhere.
//
// colorSpace is stored + surfaced only for now — a real colour-managed
// pipeline is D-004. Reached from the gear on the Colorist shot strip.
//
// D-272 — this dialog's BODY is now `@apelles/editor`'s `ProjectSettingsForm`,
// the same component the Edit tab's docked `ProjectSettingsPanel` renders in
// its Inspector column, rather than a second, hand-kept-in-sync copy of the
// resolution/fps/colour-space controls. Only the surrounding chrome (the
// backdrop + close button below) is specific to this being a dialog — see
// that component's own module doc.
//
// D-272 also moved this from a staged Save/Cancel flow to instant-apply:
// `ProjectSettingsForm` fires `onChange` per edit (the shape the ALWAYS-
// VISIBLE docked panel needs, since a permanently-open panel cannot sensibly
// carry a pending, unsaved Save button), and the shared component has to
// behave the same wherever it renders. Closing this dialog therefore just
// closes it — every edit already landed the moment it was made, same as
// every other control in this app.
import { X } from 'lucide-react';
import { toast } from 'react-toastify';
import { ProjectSettingsForm, type ProjectSettingsValue } from '@apelles/editor';

import { useSessionStore } from '../../store/useSessionStore';

export default function ProjectSettingsModal({ onClose }: { onClose: () => void }) {
  const settings = useSessionStore((s) => s.projectSettings);
  const setProjectSettings = useSessionStore((s) => s.setProjectSettings);

  const handleChange = async (patch: ProjectSettingsValue) => {
    const res = await setProjectSettings(patch);
    if (!res.ok) toast.error(`Could not save project settings: ${res.error}`);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={onClose}>
      <div
        className="w-[380px] max-w-[calc(100vw-32px)] rounded-lg border border-border-color bg-surface p-5 shadow-2xl flex flex-col gap-4"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold text-text-primary">Project settings</h2>
          <button onClick={onClose} className="text-text-secondary hover:text-text-primary">
            <X size={16} />
          </button>
        </div>

        <ProjectSettingsForm settings={settings ?? {}} onChange={handleChange} />
      </div>
    </div>
  );
}
