/**
 * @apelles/shell — window chrome (D-039).
 *
 * The app runs with `decorations: false, transparent: true` (see
 * `tauri.conf.json`) and draws its own title bar. Before D-039 that was
 * RapidRAW's `app/src/window/TitleBar.tsx`, rendered *inside* the Colorist
 * tab — so Colorist had a title bar and "RapidRAW" branding while Edit/Motion
 * had none. The chrome now belongs to the shell, once, above all three tabs.
 *
 * Platform logic is ported from that TitleBar: macOS fake traffic lights
 * (close / minimize / toggle-fullscreen) on the left; Windows/Linux window
 * controls on the right; the whole bar is a `data-tauri-drag-region` except
 * the interactive controls and the tabs (handled in `Shell.tsx`).
 *
 * Tauri coupling is acceptable here — the shell *is* the app chrome now.
 */

import { useCallback, useEffect, useState } from 'react';
import { platform } from '@tauri-apps/plugin-os';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { Minus, Square, X } from 'lucide-react';

type OsName = '' | 'macos' | 'windows' | 'linux' | 'android' | 'ios';

const RestoreDownIcon = ({ size = 13, className = '' }: { size?: number; className?: string }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 16 16"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.5"
    strokeLinecap="round"
    strokeLinejoin="round"
    className={className}
  >
    <rect x="3" y="6" width="8" height="8" rx="1.5" />
    <path d="M6 6V4.5A1.5 1.5 0 0 1 7.5 3h5A1.5 1.5 0 0 1 14 4.5v5A1.5 1.5 0 0 1 12.5 11H11" />
  </svg>
);

interface WindowChromeState {
  os: OsName;
  isMac: boolean;
  isWindows: boolean;
  isLinux: boolean;
  isMobile: boolean;
  isFullscreen: boolean;
  isMaximized: boolean;
  /** mac, windowed, decorations off → the shell root keeps rounded corners */
  useMacWindowShell: boolean;
}

/**
 * Platform + window-mode detection for the chrome. One instance in `Shell.tsx`.
 */
export function useWindowChrome(): WindowChromeState {
  const [os, setOs] = useState<OsName>('');
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [isMaximized, setIsMaximized] = useState(false);

  useEffect(() => {
    try {
      setOs(platform() as OsName);
    } catch (err) {
      console.error('WindowChrome: failed to read platform', err);
      setOs('windows');
    }
  }, []);

  useEffect(() => {
    const win = getCurrentWindow();
    let unlisten: (() => void) | undefined;

    const sync = async () => {
      try {
        setIsFullscreen(await win.isFullscreen());
        setIsMaximized(await win.isMaximized());
      } catch (err) {
        console.error('WindowChrome: failed to read window state', err);
      }
    };
    sync();
    win
      .onResized(() => sync())
      .then((u) => {
        unlisten = u;
      })
      .catch(() => {});

    return () => unlisten?.();
  }, []);

  const isMac = os === 'macos';
  return {
    os,
    isMac,
    isWindows: os === 'windows',
    isLinux: os === 'linux',
    isMobile: os === 'android' || os === 'ios',
    isFullscreen,
    isMaximized,
    useMacWindowShell: isMac && !isFullscreen,
  };
}

async function toggleMaximize(isMac: boolean) {
  const win = getCurrentWindow();
  try {
    if (isMac) {
      win.setFullscreen(!(await win.isFullscreen()));
    } else {
      win.toggleMaximize();
    }
  } catch (err) {
    console.error('WindowChrome: toggle maximize failed', err);
  }
}

/** macOS fake traffic lights. Renders nothing off macOS. */
export function MacTrafficLights({ show }: { show: boolean }) {
  if (!show) return null;
  const win = getCurrentWindow();
  return (
    <div className="flex items-center gap-2 pl-1 pr-3">
      <button
        aria-label="Close window"
        className="w-3 h-3 rounded-full bg-red-500 hover:bg-red-600 transition-colors duration-150"
        onClick={() => win.close()}
      />
      <button
        aria-label="Minimize window"
        className="w-3 h-3 rounded-full bg-yellow-500 hover:bg-yellow-600 transition-colors duration-150"
        onClick={() => win.minimize()}
      />
      <button
        aria-label="Toggle fullscreen"
        className="w-3 h-3 rounded-full bg-green-500 hover:bg-green-600 transition-colors duration-150"
        onClick={() => toggleMaximize(true)}
      />
    </div>
  );
}

/**
 * Windows / Linux window controls (right side). On macOS returns a spacer the
 * same width as the traffic lights so `Shell.tsx` can keep the tabs truly
 * centred. Renders nothing on mobile.
 */
export function WindowControls({ chrome }: { chrome: WindowChromeState }) {
  const { isWindows, isLinux, isMac, isMobile, isMaximized } = chrome;
  const win = getCurrentWindow();

  const handleMaximize = useCallback(() => toggleMaximize(isMac), [isMac]);

  if (isMobile) return null;

  if (isMac) {
    // keep the tabs centred: mirror the traffic-lights cluster width
    return <div className="w-[72px] shrink-0" aria-hidden />;
  }

  if (isLinux) {
    return (
      <div className="flex items-center gap-2 pr-2 h-full">
        <button
          aria-label="Minimize window"
          className="w-7 h-7 rounded-full inline-flex justify-center items-center hover:bg-white/10 transition-colors duration-150"
          onClick={() => win.minimize()}
        >
          <Minus size={16} className="text-text-secondary" />
        </button>
        <button
          aria-label="Maximize window"
          className="w-7 h-7 rounded-full inline-flex justify-center items-center hover:bg-white/10 transition-colors duration-150"
          onClick={handleMaximize}
        >
          {isMaximized ? (
            <RestoreDownIcon size={13} className="text-text-secondary" />
          ) : (
            <Square size={13} className="text-text-secondary" />
          )}
        </button>
        <button
          aria-label="Close window"
          className="w-7 h-7 rounded-full inline-flex justify-center items-center hover:bg-red-500 hover:text-white transition-colors duration-150"
          onClick={() => win.close()}
        >
          <X size={16} className="text-text-secondary hover:text-white" />
        </button>
      </div>
    );
  }

  if (isWindows) {
    return (
      <div className="flex h-full items-stretch">
        <button
          aria-label="Minimize window"
          className="w-12 flex justify-center items-center hover:bg-white/10 active:bg-white/20 transition-colors duration-150"
          onClick={() => win.minimize()}
        >
          <Minus size={16} className="text-text-secondary" />
        </button>
        <button
          aria-label="Maximize window"
          className="w-12 flex justify-center items-center hover:bg-white/10 active:bg-white/20 transition-colors duration-150"
          onClick={handleMaximize}
        >
          {isMaximized ? (
            <RestoreDownIcon size={12} className="text-text-secondary" />
          ) : (
            <Square size={12} className="text-text-secondary" />
          )}
        </button>
        <button
          aria-label="Close window"
          className="w-12 flex justify-center items-center hover:bg-red-500 active:bg-red-600 group transition-colors duration-150"
          onClick={() => win.close()}
        >
          <X size={16} className="text-text-secondary group-hover:text-white transition-colors duration-150" />
        </button>
      </div>
    );
  }

  return null;
}
