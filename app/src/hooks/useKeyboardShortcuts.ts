import { useCallback, useEffect, useMemo, useRef } from 'react';
import { toast } from 'react-toastify';
import { ImageFile, Panel } from '../components/ui/AppProperties';
import { useShortcuts } from '@apelles/keymap';
import { useEditorStore } from '../store/useEditorStore';
import { useLibraryStore } from '../store/useLibraryStore';
import { useSettingsStore } from '../store/useSettingsStore';
import { useUIStore } from '../store/useUIStore';
import { useProcessStore } from '../store/useProcessStore';
import { useEditorActions } from './useEditorActions';
import { useLibraryActions } from './useLibraryActions';

interface KeyboardShortcutsProps {
  sortedImageList: Array<ImageFile>;
  handleDeleteSelected(): void;
  handleImageSelect(path: string, openInEditor?: boolean): void;
  handleToggleFullScreen(): void;
  handleZoomChange(zoomValue: number, fitToWindow?: boolean): void;
}

export const useKeyboardShortcuts = ({
  sortedImageList,
  handleDeleteSelected,
  handleImageSelect,
  handleToggleFullScreen,
  handleZoomChange,
}: KeyboardShortcutsProps) => {
  const { handleRotate, handleCopyAdjustments, handlePasteAdjustments, toggleShowOriginal } = useEditorActions();
  const { handleRate, handleSetColorLabel } = useLibraryActions();

  const sortedListRef = useRef(sortedImageList);
  useEffect(() => {
    sortedListRef.current = sortedImageList;
  }, [sortedImageList]);

  const handleCopyImagePaths = useCallback(async (paths: Array<string>) => {
    const physicalPaths = [...new Set(paths.map((path) => path.split('?vc=')[0]))];
    if (physicalPaths.length === 0) {
      return;
    }
    try {
      await navigator.clipboard.writeText(physicalPaths.join('\n'));
    } catch (err) {
      console.error('Failed to copy image path to clipboard', err);
      toast.error(`Failed to copy path: ${err}`);
    }
  }, []);

  const { actions, builtinShortcuts } = useMemo(() => {
    const getStoreState = () => ({
      editor: useEditorStore.getState(),
      library: useLibraryStore.getState(),
      ui: useUIStore.getState(),
      settings: useSettingsStore.getState(),
      process: useProcessStore.getState(),
    });

    const getImagePathsForCopy = (s: any): Array<string> => {
      if (s.editor.selectedImage) {
        return [s.editor.selectedImage.path];
      }
      const { libraryActivePath, multiSelectedPaths } = s.library;
      if (multiSelectedPaths.length > 0) {
        const listOrder = new Map(sortedListRef.current.map((image: ImageFile, index: number) => [image.path, index]));
        return [...multiSelectedPaths].sort(
          (a: string, b: string) =>
            (listOrder.get(a) ?? Number.MAX_SAFE_INTEGER) - (listOrder.get(b) ?? Number.MAX_SAFE_INTEGER),
        );
      }
      return libraryActivePath ? [libraryActivePath] : [];
    };

    const actions: Record<string, any> = {
      copy_adjustments: {
        shouldFire: () => true,
        execute: (e: any) => {
          e.preventDefault();
          handleCopyAdjustments();
        },
      },
      paste_adjustments: {
        shouldFire: () => true,
        execute: (e: any) => {
          e.preventDefault();
          handlePasteAdjustments();
        },
      },
      copy_image_path: {
        shouldFire: (s: any) => getImagePathsForCopy(s).length > 0,
        execute: (e: any, s: any) => {
          e.preventDefault();
          handleCopyImagePaths(getImagePathsForCopy(s));
        },
      },
      copy_files: {
        shouldFire: (s: any) => s.library.multiSelectedPaths.length > 0,
        execute: (e: any, s: any) => {
          e.preventDefault();
          s.process.setProcess({ copiedFilePaths: s.library.multiSelectedPaths });
        },
      },
      select_all: {
        shouldFire: () => sortedListRef.current.length > 0,
        execute: (e: any, s: any) => {
          e.preventDefault();
          s.library.setLibrary({ multiSelectedPaths: sortedListRef.current.map((f: ImageFile) => f.path) });
        },
      },
      delete_selected: {
        shouldFire: (s: any) => !s.editor.activeMaskContainerId && !s.editor.activeAiPatchContainerId,
        execute: (e: any) => {
          e.preventDefault();
          handleDeleteSelected();
        },
      },
      preview_prev: {
        shouldFire: (s: any) => !!s.editor.selectedImage,
        execute: (e: any, s: any) => {
          e.preventDefault();
          const currentIndex = sortedListRef.current.findIndex((img) => img.path === s.editor.selectedImage!.path);
          if (currentIndex === -1) return;
          const nextIndex = currentIndex - 1 < 0 ? sortedListRef.current.length - 1 : currentIndex - 1;
          handleImageSelect(sortedListRef.current[nextIndex].path, true);
        },
      },
      preview_next: {
        shouldFire: (s: any) => !!s.editor.selectedImage,
        execute: (e: any, s: any) => {
          e.preventDefault();
          const currentIndex = sortedListRef.current.findIndex((img) => img.path === s.editor.selectedImage!.path);
          if (currentIndex === -1) return;
          const nextIndex = currentIndex + 1 >= sortedListRef.current.length ? 0 : currentIndex + 1;
          handleImageSelect(sortedListRef.current[nextIndex].path, true);
        },
      },
      zoom_in_step: {
        shouldFire: (s: any) => !!s.editor.selectedImage,
        execute: (e: any, s: any) => {
          e.preventDefault();
          const dpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1;
          const currentPercent =
            s.editor.originalSize?.width > 0 && s.editor.displaySize?.width > 0
              ? (s.editor.displaySize.width * dpr) / s.editor.originalSize.width
              : 1.0;
          handleZoomChange(Math.min(currentPercent + 0.1, 2.0));
        },
      },
      zoom_out_step: {
        shouldFire: (s: any) => !!s.editor.selectedImage,
        execute: (e: any, s: any) => {
          e.preventDefault();
          const dpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1;
          const currentPercent =
            s.editor.originalSize?.width > 0 && s.editor.displaySize?.width > 0
              ? (s.editor.displaySize.width * dpr) / s.editor.originalSize.width
              : 1.0;
          handleZoomChange(Math.max(currentPercent - 0.1, 0.1));
        },
      },
      cycle_zoom: {
        shouldFire: (s: any) => !!s.editor.selectedImage,
        execute: (e: any, s: any) => {
          e.preventDefault();
          const dpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1;
          const { originalSize, displaySize, baseRenderSize } = s.editor;
          const currentPercent =
            originalSize?.width > 0 && displaySize?.width > 0
              ? Math.round(((displaySize.width * dpr) / originalSize.width) * 100)
              : 100;
          let fitPercent = 100;

          if (originalSize?.width > 0 && baseRenderSize?.width > 0) {
            const originalAspect = originalSize.width / originalSize.height;
            const baseAspect = baseRenderSize.width / baseRenderSize.height;
            fitPercent =
              originalAspect > baseAspect
                ? Math.round(((baseRenderSize.width * dpr) / originalSize.width) * 100)
                : Math.round(((baseRenderSize.height * dpr) / originalSize.height) * 100);
          }

          const doubleFitPercent = fitPercent * 2;
          if (Math.abs(currentPercent - fitPercent) < 5) {
            handleZoomChange(doubleFitPercent < 100 ? doubleFitPercent / 100 : 1.0);
          } else if (Math.abs(currentPercent - doubleFitPercent) < 5 && doubleFitPercent < 100) {
            handleZoomChange(1.0);
          } else {
            handleZoomChange(0, true);
          }
        },
      },
      zoom_in: {
        shouldFire: (s: any) => !!s.editor.selectedImage,
        execute: (e: any, s: any) => {
          e.preventDefault();
          const dpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1;
          const currentPercent =
            s.editor.originalSize?.width > 0 && s.editor.displaySize?.width > 0
              ? (s.editor.displaySize.width * dpr) / s.editor.originalSize.width
              : 1.0;
          handleZoomChange(Math.min(currentPercent * 1.2, 2.0));
        },
      },
      zoom_out: {
        shouldFire: (s: any) => !!s.editor.selectedImage,
        execute: (e: any, s: any) => {
          e.preventDefault();
          const dpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1;
          const currentPercent =
            s.editor.originalSize?.width > 0 && s.editor.displaySize?.width > 0
              ? (s.editor.displaySize.width * dpr) / s.editor.originalSize.width
              : 1.0;
          handleZoomChange(Math.max(currentPercent / 1.2, 0.1));
        },
      },
      zoom_fit: {
        shouldFire: (s: any) => !!s.editor.selectedImage,
        execute: (e: any) => {
          e.preventDefault();
          handleZoomChange(0, true);
        },
      },
      zoom_100: {
        shouldFire: (s: any) => !!s.editor.selectedImage,
        execute: (e: any) => {
          e.preventDefault();
          handleZoomChange(1.0);
        },
      },
      rotate_left: {
        shouldFire: (s: any) => !!s.editor.selectedImage || !!s.library.libraryActivePath,
        execute: (e: any) => {
          e.preventDefault();
          handleRotate(-90);
        },
      },
      rotate_right: {
        shouldFire: (s: any) => !!s.editor.selectedImage || !!s.library.libraryActivePath,
        execute: (e: any) => {
          e.preventDefault();
          handleRotate(90);
        },
      },
      // D-051: undo/redo moved to the shell-level global keybinding
      // (`@apelles/shell`'s `Shell.tsx`, Cmd/Ctrl+Z / Cmd/Ctrl+Y), which pops
      // `@apelles/history`'s shared stack via the `useColoristHistoryBridge`
      // adapter — that stack's entries call `useEditorStore`'s
      // `goToHistoryIndex`/`setEditor`+`pushHistory` under the hood, so the
      // net effect on this store is identical. No handler here anymore: a
      // second Cmd/Ctrl+Z listener on this same combo would double-undo
      // whenever the Colorist tab is active. `KEYBIND_DEFINITIONS` above
      // still lists `undo`/`redo` (`Ctrl+Z`/`Ctrl+Y`) purely for the
      // keybinds settings display — still accurate, since the shell uses the
      // same combo — `comboMap` resolving to an action with no handler here
      // is a deliberate, safe no-op (see `handleKeyDown` below).
      toggle_fullscreen: {
        shouldFire: (s: any) => !!s.editor.selectedImage,
        execute: (e: any) => {
          e.preventDefault();
          handleToggleFullScreen();
        },
      },
      show_original: {
        shouldFire: (s: any) => !!s.editor.selectedImage,
        execute: (e: any) => {
          e.preventDefault();
          toggleShowOriginal();
        },
      },
      toggle_adjustments: {
        shouldFire: () => true,
        execute: (e: any, s: any) => {
          e.preventDefault();
          s.ui.setPanel(Panel.Adjustments);
        },
      },
      toggle_crop_panel: {
        shouldFire: () => true,
        execute: (e: any, s: any) => {
          e.preventDefault();
          s.ui.setPanel(Panel.Crop);
        },
      },
      toggle_masks: {
        shouldFire: () => true,
        execute: (e: any, s: any) => {
          e.preventDefault();
          s.ui.setPanel(Panel.Masks);
        },
      },
      toggle_ai: {
        shouldFire: () => true,
        execute: (e: any, s: any) => {
          e.preventDefault();
          s.ui.setPanel(Panel.Ai);
        },
      },
      toggle_presets: {
        shouldFire: () => true,
        execute: (e: any, s: any) => {
          e.preventDefault();
          s.ui.setPanel(Panel.Presets);
        },
      },
      toggle_metadata: {
        shouldFire: () => true,
        execute: (e: any, s: any) => {
          e.preventDefault();
          s.ui.setPanel(Panel.Metadata);
        },
      },
      toggle_analytics: {
        shouldFire: (s: any) => !!s.editor.selectedImage,
        execute: (e: any, s: any) => {
          e.preventDefault();
          const nextVisibility = !s.editor.isWaveformVisible;
          s.editor.setEditor({ isWaveformVisible: nextVisibility });
          s.settings.handleSettingsChange({
            ...s.settings.appSettings,
            isWaveformVisible: nextVisibility,
          });
        },
      },
      toggle_export: {
        shouldFire: () => true,
        execute: (e: any, s: any) => {
          e.preventDefault();
          s.ui.setPanel(Panel.Export);
        },
      },
      toggle_left_panel: {
        shouldFire: () => true,
        execute: (e: any, s: any) => {
          e.preventDefault();
          const isOpening = !s.ui.uiVisibility.leftPanel;
          s.ui.setUI((state: any) => ({
            uiVisibility: { ...state.uiVisibility, leftPanel: isOpening },
            leftPanelWidth: isOpening && state.leftPanelWidth < 250 ? 350 : state.leftPanelWidth,
          }));
        },
      },
      toggle_right_panel: {
        shouldFire: () => true,
        execute: (e: any, s: any) => {
          e.preventDefault();
          const isOpening = !s.ui.uiVisibility.rightPanel;
          s.ui.setUI((state: any) => ({
            uiVisibility: { ...state.uiVisibility, rightPanel: isOpening },
            rightPanelWidth: isOpening && state.rightPanelWidth < 250 ? 350 : state.rightPanelWidth,
          }));
        },
      },
      toggle_bottom_panel: {
        shouldFire: () => true,
        execute: (e: any, s: any) => {
          e.preventDefault();
          s.ui.setUI((state: any) => ({
            uiVisibility: { ...state.uiVisibility, filmstrip: !state.uiVisibility.filmstrip },
          }));
        },
      },
      open_settings: {
        shouldFire: () => true,
        execute: (e: any, s: any) => {
          e.preventDefault();
          s.ui.setUI({ isSettingsOpen: true });
        },
      },
      toggle_crop: {
        shouldFire: (s: any) => !!s.editor.selectedImage,
        execute: (e: any, s: any) => {
          e.preventDefault();
          if (s.ui.activePanel === Panel.Crop) {
            s.editor.setEditor({ isStraightenActive: !s.editor.isStraightenActive });
          } else {
            s.ui.setPanel(Panel.Crop);
            s.editor.setEditor({ isStraightenActive: true });
          }
        },
      },
      rate_0: {
        shouldFire: () => true,
        execute: (e: any) => {
          e.preventDefault();
          handleRate(0);
        },
      },
      rate_1: {
        shouldFire: () => true,
        execute: (e: any) => {
          e.preventDefault();
          handleRate(1);
        },
      },
      rate_2: {
        shouldFire: () => true,
        execute: (e: any) => {
          e.preventDefault();
          handleRate(2);
        },
      },
      rate_3: {
        shouldFire: () => true,
        execute: (e: any) => {
          e.preventDefault();
          handleRate(3);
        },
      },
      rate_4: {
        shouldFire: () => true,
        execute: (e: any) => {
          e.preventDefault();
          handleRate(4);
        },
      },
      rate_5: {
        shouldFire: () => true,
        execute: (e: any) => {
          e.preventDefault();
          handleRate(5);
        },
      },
      color_label_none: {
        shouldFire: () => true,
        execute: (e: any) => {
          e.preventDefault();
          handleSetColorLabel(null);
        },
      },
      color_label_red: {
        shouldFire: () => true,
        execute: (e: any) => {
          e.preventDefault();
          handleSetColorLabel('red');
        },
      },
      color_label_yellow: {
        shouldFire: () => true,
        execute: (e: any) => {
          e.preventDefault();
          handleSetColorLabel('yellow');
        },
      },
      color_label_green: {
        shouldFire: () => true,
        execute: (e: any) => {
          e.preventDefault();
          handleSetColorLabel('green');
        },
      },
      color_label_blue: {
        shouldFire: () => true,
        execute: (e: any) => {
          e.preventDefault();
          handleSetColorLabel('blue');
        },
      },
      color_label_purple: {
        shouldFire: () => true,
        execute: (e: any) => {
          e.preventDefault();
          handleSetColorLabel('purple');
        },
      },
      brush_size_up: {
        shouldFire: (s: any) =>
          !!s.editor.selectedImage && (s.ui.activePanel === Panel.Masks || s.ui.activePanel === Panel.Ai),
        execute: (e: any, s: any) => {
          e.preventDefault();
          const currentSettings = s.editor.brushSettings || { size: 50 };
          const newSize = Math.min((currentSettings.size || 50) + 10, 200);
          s.editor.setEditor({
            brushSettings: { ...currentSettings, size: newSize },
          });
        },
      },
      brush_size_down: {
        shouldFire: (s: any) =>
          !!s.editor.selectedImage && (s.ui.activePanel === Panel.Masks || s.ui.activePanel === Panel.Ai),
        execute: (e: any, s: any) => {
          e.preventDefault();
          const currentSettings = s.editor.brushSettings || { size: 50 };
          const newSize = Math.max((currentSettings.size || 50) - 10, 1);
          s.editor.setEditor({
            brushSettings: { ...currentSettings, size: newSize },
          });
        },
      },
    };

    const builtinShortcuts = [
      {
        match: (e: KeyboardEvent) => e.code === 'Escape',
        execute: (e: KeyboardEvent, s: any) => {
          e.preventDefault();
          if (s.editor.isStraightenActive) s.editor.setEditor({ isStraightenActive: false });
          else if (s.ui.customEscapeHandler) s.ui.customEscapeHandler();
          else if (s.editor.activeAiSubMaskId) s.editor.setEditor({ activeAiSubMaskId: null });
          else if (s.editor.activeAiPatchContainerId) s.editor.setEditor({ activeAiPatchContainerId: null });
          else if (s.editor.activeMaskId) s.editor.setEditor({ activeMaskId: null });
          else if (s.editor.activeMaskContainerId) s.editor.setEditor({ activeMaskContainerId: null });
          else if (s.ui.activePanel === Panel.Crop) s.ui.setPanel(Panel.Adjustments);
          else if (s.ui.isFullScreen) handleToggleFullScreen();
        },
      },
      {
        match: (e: KeyboardEvent, s: any) => {
          const isDeleteKey = s.settings.osPlatform === 'macos' ? e.code === 'Backspace' : e.code === 'Delete';
          return isDeleteKey && (!!s.editor.activeMaskContainerId || !!s.editor.activeAiPatchContainerId);
        },
        execute: (e: KeyboardEvent, s: any) => {
          e.preventDefault();
          if (s.editor.activeMaskContainerId) {
            s.editor.setEditor((state: any) => ({
              adjustments: {
                ...state.adjustments,
                masks: state.adjustments.masks.filter((c: any) => c.id !== s.editor.activeMaskContainerId),
              },
              activeMaskContainerId: null,
              activeMaskId: null,
            }));
          } else if (s.editor.activeAiPatchContainerId) {
            s.editor.setEditor((state: any) => ({
              adjustments: {
                ...state.adjustments,
                aiPatches: state.adjustments.aiPatches.filter((c: any) => c.id !== s.editor.activeAiPatchContainerId),
              },
              activeAiPatchContainerId: null,
              activeAiSubMaskId: null,
            }));
          }
        },
      },
    ];

    return { actions, builtinShortcuts };
  }, [
    handleDeleteSelected,
    handleImageSelect,
    handleToggleFullScreen,
    handleZoomChange,
    handleRotate,
    handleCopyAdjustments,
    handleCopyImagePaths,
    handlePasteAdjustments,
    handleRate,
    handleSetColorLabel,
    toggleShowOriginal,
  ]);

  // D-272 — the Colorist actions above are now claimed from the shared
  // registry (`@apelles/keymap`) instead of this hook owning its own `window`
  // listener and its own copy of the keybind table.
  //
  // Two things this fixes, both real:
  //
  //   1. **B-138.** This hook is mounted by `App.tsx`, which stays mounted
  //      under every tab (B-007), and a `window` listener has no idea which
  //      tab is on screen — so `toggle_masks`, `toggle_export`, the rating
  //      keys and the rest (all `shouldFire: () => true`) fired while the user
  //      was in the Edit or Motion tab, silently rearranging Colorist behind
  //      them. Every row is `scope: 'colorist'` in the registry, so the
  //      dispatcher will not even consider them unless Colorist is frontmost.
  //   2. **The keybind table was duplicated.** `KEYBIND_DEFINITIONS` lived in
  //      `app/src/utils/keyboardUtils.ts`, which `packages/*` could never
  //      import (dependency direction), so the Edit tab grew its own hardcoded
  //      keys. That file is gone; its contents are the `colorist`-scoped rows
  //      of the one registry, ids and defaults unchanged so existing user
  //      remaps in `appSettings.keybinds` keep working.
  //
  // `shouldFire` is checked here rather than by the dispatcher: it is a
  // per-action precondition about Colorist's own state ("is an image open"),
  // which the registry deliberately knows nothing about. An action whose
  // precondition is false simply does nothing, exactly as before.
  const blocked = () => {
    const ui = useUIStore.getState();
    return (
      ui.isRenameFileModalOpen ||
      ui.isCopyPasteSettingsModalOpen ||
      ui.confirmModalState.isOpen ||
      ui.panoramaModalState.isOpen ||
      ui.collageModalState.isOpen ||
      ui.denoiseModalState.isOpen ||
      ui.negativeModalState.isOpen ||
      ui.isSettingsOpen
    );
  };

  const handlerMap = useMemo(() => {
    const map: Record<string, (event: KeyboardEvent) => void> = {};
    for (const [action, handler] of Object.entries(actions)) {
      map[action] = (event: KeyboardEvent) => {
        if (blocked()) return;
        const state = {
          editor: useEditorStore.getState(),
          library: useLibraryStore.getState(),
          ui: useUIStore.getState(),
          settings: useSettingsStore.getState(),
          process: useProcessStore.getState(),
        };
        if (handler.shouldFire && !handler.shouldFire(state)) return;
        handler.execute(event, state);
      };
    }
    return map;
  }, [actions]);

  useShortcuts(handlerMap);

  // The two BUILT-IN gestures stay a listener of their own, deliberately, and
  // are not registry rows: "Escape backs out of whatever is innermost" and
  // "Delete removes the mask container you are currently inside" are modal,
  // contextual behaviours whose meaning depends entirely on what is open —
  // not shortcuts a user could meaningfully rebind, and macOS's own Keyboard
  // Shortcuts pane lists no equivalent either (see `@apelles/keymap`'s README,
  // "Not covered, deliberately"). They keep the settings-modal Escape path
  // this hook has always had.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const state = {
        editor: useEditorStore.getState(),
        library: useLibraryStore.getState(),
        ui: useUIStore.getState(),
        settings: useSettingsStore.getState(),
        process: useProcessStore.getState(),
      };

      if (state.ui.isSettingsOpen) {
        if (event.code === 'Escape') {
          event.preventDefault();
          state.ui.setUI({ isSettingsOpen: false });
        }
        return;
      }
      if (blocked()) return;

      const isInputFocused =
        document.activeElement?.tagName === 'INPUT' || document.activeElement?.tagName === 'TEXTAREA';
      if (isInputFocused) return;

      for (const builtin of builtinShortcuts) {
        if (builtin.match(event, state)) {
          builtin.execute(event, state);
          return;
        }
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [builtinShortcuts]);
};
