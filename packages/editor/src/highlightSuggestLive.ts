/**
 * @apelles/editor — the live wiring for `suggestClipHighlights` (D-397).
 *
 * What it is: `liveSuggestDeps`, the real dependencies of the suggestion — the
 * open timeline, the transcript store and the `chroma_ocr_media` Tauri command —
 * in one place for the MCP op (`useEditorControl`) and the Inspector button to
 * share. Kept out of `highlightSuggestOp.ts` so that module stays free of Tauri
 * and testable with fakes.
 */

import { invoke } from '@tauri-apps/api/core';
import { useMediaUnderstandingStore } from './mediaUnderstandingStore';
import { useEditorTimelineStore } from './timelineStore';
import type { OcrLine } from './highlightSuggest';
import type { SuggestDeps } from './highlightSuggestOp';

export function liveSuggestDeps(): SuggestDeps {
  return {
    timeline: useEditorTimelineStore.getState().timeline,
    transcriptStatus: (path) => useMediaUnderstandingStore.getState().transcriptStatus(path),
    ocr: (sourcePath, sourceFrame) =>
      invoke<OcrLine[]>('chroma_ocr_media', { sourcePath, sourceFrame: Math.max(0, Math.round(sourceFrame)) }),
  };
}
