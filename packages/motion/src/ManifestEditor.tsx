/**
 * @chroma/motion — the raw scene-manifest JSON textarea (D-046).
 *
 * D-172 — following through on D-153's own research doc (Part C), which
 * this file originally implemented in a smaller shape: Save/Render, the
 * `</>` collapse toggle, the dirty indicator, and the save/render error
 * strip all moved OUT of this component into `MotionTab.tsx`'s own
 * always-visible toolbar. That's what actually avoids D-153's own named
 * trap — those facts living inside a panel that disappears along with the
 * JSON — rather than partially avoiding it while still leaving the whole
 * panel (and its ~420px of width) permanently reserved on screen even when
 * collapsed, which is what this file used to do and the owner pointed
 * directly at as still wrong.
 *
 * What's left here is deliberately small: the textarea, live-parsed
 * (debounced in `useMotionManifest`), and its own parse-error readout when
 * this panel is actually shown — `MotionTab.tsx` decides WHETHER this
 * component mounts at all (`showManifest`), this component has no opinion
 * about that.
 */
interface Props {
  text: string;
  onChange: (text: string) => void;
  parseError: string | null;
}

export function ManifestEditor({ text, onChange, parseError }: Props) {
  return (
    <div className="h-full w-full flex flex-col min-h-0">
      <textarea
        className="flex-1 min-h-0 resize-none bg-bg-secondary text-text-primary font-mono text-[11px] leading-relaxed p-3 outline-none border-0"
        spellCheck={false}
        value={text}
        onChange={(e) => onChange(e.target.value)}
      />
      {parseError && (
        <div className="shrink-0 border-t border-border-color px-3 py-2 text-xs max-h-32 overflow-auto">
          <pre className="text-red-400 whitespace-pre-wrap">{parseError}</pre>
        </div>
      )}
    </div>
  );
}
