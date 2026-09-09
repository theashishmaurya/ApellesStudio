// Apelles — video transport state. Kept separate from useEditorStore so the fork
// diff stays small (docs/08 D-003).
import { create } from 'zustand';

export interface ChromaVideoInfo {
  isVideo: boolean;
  path: string;
  width: number;
  height: number;
  fps: number;
  frameCount: number;
  durationSecs: number;
  frame: number;
  codec: string;
  colorSpace: string;
  colorTransfer: string;
}

interface ChromaState {
  videoInfo: ChromaVideoInfo | null;
  /** the frame the transport wants shown */
  currentFrame: number;
  /** bumped after a successful seek (or a matte upgrade) to trigger a re-render */
  frameNonce: number;
  isSeeking: boolean;
  /** {done,total} while a /track pass runs, else null */
  trackProgress: { done: number; total: number } | null;
  /** {done,total} while a /depth_track pass runs, else null (D-036) */
  depthTrackProgress: { done: number; total: number } | null;

  setVideoInfo: (v: ChromaVideoInfo | null) => void;
  setCurrentFrame: (f: number) => void;
  bumpFrameNonce: () => void;
  setSeeking: (b: boolean) => void;
  setTrackProgress: (p: { done: number; total: number } | null) => void;
  setDepthTrackProgress: (p: { done: number; total: number } | null) => void;
  reset: () => void;
}

export const useChromaStore = create<ChromaState>((set) => ({
  videoInfo: null,
  currentFrame: 0,
  frameNonce: 0,
  isSeeking: false,
  trackProgress: null,
  depthTrackProgress: null,

  setVideoInfo: (videoInfo) =>
    set({ videoInfo, currentFrame: videoInfo?.frame ?? 0, trackProgress: null, depthTrackProgress: null }),
  setCurrentFrame: (currentFrame) => set({ currentFrame }),
  bumpFrameNonce: () => set((s) => ({ frameNonce: s.frameNonce + 1 })),
  setSeeking: (isSeeking) => set({ isSeeking }),
  setTrackProgress: (trackProgress) => set({ trackProgress }),
  setDepthTrackProgress: (depthTrackProgress) => set({ depthTrackProgress }),
  reset: () =>
    set({ videoInfo: null, currentFrame: 0, isSeeking: false, trackProgress: null, depthTrackProgress: null }),
}));
