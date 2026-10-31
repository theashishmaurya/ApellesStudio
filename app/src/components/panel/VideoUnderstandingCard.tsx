/**
 * D-432 — the "AI video understanding" opt-in, as a Settings card.
 *
 * What it is: the toggle for the persisted `enableVideoUnderstanding` setting
 * (default OFF), the Mac's installed RAM beside it, and a warning under 16 GB.
 * What it does NOT do: gate anything. The refusal lives in Rust
 * (`chroma_analyze_video`), so the GUI and the MCP share one choke point; this
 * card only flips the setting through `@apelles/bridge` and tells the user what
 * it costs. The toggle stays usable on a small Mac — the warning is advice.
 */
import { formatRam, lowMemoryWarning, useVideoUnderstanding } from '@apelles/bridge';
import { useState } from 'react';

import Switch from '../ui/Switch';
import Text from '../ui/Text';
import { TextColors, TextVariants } from '../../types/typography';

export default function VideoUnderstandingCard() {
  const { status, setEnabled } = useVideoUnderstanding();
  const [error, setError] = useState<string | null>(null);
  const ram = status ? formatRam(status.totalMemoryBytes) : null;
  const warning = status ? lowMemoryWarning(status) : null;

  return (
    <div className="p-6 bg-surface rounded-xl shadow-md">
      <Text variant={TextVariants.title} color={TextColors.accent} className="mb-2">
        AI video understanding
      </Text>
      <Text variant={TextVariants.small} className="mb-6 opacity-60">
        Describes what&apos;s on screen. Downloads a ~3 GB model; uses up to ~9 GB of memory while
        it runs. Recommended for Macs with 24 GB or more. Transcription is not affected.
      </Text>
      <Switch
        id="enable-video-understanding-toggle"
        label="AI video understanding"
        checked={status?.enabled ?? false}
        disabled={status === null}
        onChange={(checked) => {
          setError(null);
          setEnabled(checked).catch((e: unknown) => {
            setError(e instanceof Error ? e.message : String(e));
          });
        }}
      />
      {ram && (
        <Text variant={TextVariants.small} className="mt-3 opacity-60">
          This Mac has {ram} of memory.
        </Text>
      )}
      {warning && (
        <Text variant={TextVariants.small} className="mt-2 text-amber-400" role="alert">
          {warning}
        </Text>
      )}
      {error && (
        <Text variant={TextVariants.small} color={TextColors.error} className="mt-2">
          {error}
        </Text>
      )}
    </div>
  );
}
