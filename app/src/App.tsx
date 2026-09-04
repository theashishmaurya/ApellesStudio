import { type PointerEvent as ReactPointerEvent, useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { safeUnlisten } from './utils/tauriListeners';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { ToastContainer, toast, Slide } from 'react-toastify';
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  useSensor,
  useSensors,
  Modifier,
  MeasuringStrategy,
  pointerWithin,
} from '@dnd-kit/core';
import clsx from 'clsx';
import { useShellStore } from '@chroma/shell';

import SettingsPanel from './components/panel/SettingsPanel';
import ExportPanel from './components/panel/right/ExportPanel';
import GlobalTooltip from './components/ui/GlobalTooltip';
import AppModals from './components/modals/AppModals';

import SidePanelArea from './components/panel/SidePanelArea';
import { PANEL_ICONS } from './components/panel/PanelSwitcher';
import Controls from './components/panel/right/ControlsPanel';
import MetadataPanel from './components/panel/right/MetadataPanel';
import CropPanel from './components/panel/right/CropPanel';
import MasksPanel from './components/panel/right/MasksPanel';
import RelightPanel from './components/chroma/RelightPanel';
import AIPanel from './components/panel/right/AIPanel';
import PresetsPanel from './components/panel/right/PresetsPanel';
import TetheringPanel from './components/panel/right/TetheringPanel';

import EditorView from './components/views/EditorView';
import ColoristEmptyState from './components/chroma/ColoristEmptyState';

import { ContextMenuProvider } from './context/ContextMenuContext';
import { useSettingsStore } from './store/useSettingsStore';
import { DEFAULT_BOTTOM_PANEL_HEIGHT, DEFAULT_PANEL_WIDTH, useUIStore } from './store/useUIStore';
import { useLibraryStore } from './store/useLibraryStore';
import { useEditorStore } from './store/useEditorStore';
import { useProcessStore } from './store/useProcessStore';
import { useShallow } from 'zustand/react/shallow';

import { useThumbnails } from './hooks/useThumbnails';
import { ImageDimensions } from './hooks/useImageRenderSize';
import { useKeyboardShortcuts } from './hooks/useKeyboardShortcuts';
import { useTauriListeners } from './hooks/useTauriListeners';
import { useFileOperations } from './hooks/useFileOperations';
import { useAppContextMenus } from './hooks/useAppContextMenus';
import { useSortedLibrary } from './hooks/useSortedLibrary';
import { useAppNavigation } from './hooks/useAppNavigation';
import { useExternalEditSession } from './hooks/useExternalEditSession';
import { useChromaControl } from './hooks/useChromaControl';
import { useProjectAutosave } from './hooks/useProjectAutosave';
import { useColoristHistoryBridge } from './hooks/useColoristHistoryBridge';
import AgentActivityDock from './components/chroma/AgentActivityDock';
import ExternalEditBar from './components/ui/ExternalEditBar';
import { Status } from './components/ui/ExportImportProperties';

import { useEditorActions } from './hooks/useEditorActions';
import { useLibraryActions } from './hooks/useLibraryActions';
import { useProductivityActions } from './hooks/useProductivityActions';

import { useAppInitialization } from './hooks/useAppInitialization';
import { useAndroidBackHandler } from './hooks/useAndroidBackHandler';
import './i18n';

import { Invokes, ImageFile, Panel, PanelRegion, Theme, ThumbnailSize, ThumbnailAspectRatio } from './components/ui/AppProperties';

import ImageProcessingManager from './components/managers/ImageProcessingManager';
import ImageLoaderManager from './components/managers/ImageLoaderManager';


const imageDragModifier: Modifier = ({ active, activatorEvent, activeNodeRect, transform }) => {
  if (active?.data?.current?.type === 'library-image' && activatorEvent && activeNodeRect) {
    const event = activatorEvent as any;
    const startX = event.clientX ?? event.touches?.[0]?.clientX ?? 0;
    const startY = event.clientY ?? event.touches?.[0]?.clientY ?? 0;

    if (startX === 0 && startY === 0) return transform;

    const offsetX = startX - activeNodeRect.left - 48;
    const offsetY = startY - activeNodeRect.top - 48;

    return {
      ...transform,
      x: transform.x + offsetX,
      y: transform.y + offsetY,
    };
  }
  return transform;
};

function ImageDragOverlayNode({ activeItem }: { activeItem: { path: string; paths: string[] } }) {
  const url = useProcessStore.getState().thumbnails[activeItem.path];
  const count = activeItem.paths.length;

  return (
    <div className="w-24 h-24 rounded-lg shadow-2xl border-2 border-accent relative bg-surface overflow-hidden flex items-center justify-center">
      {url && <img src={url} className="w-full h-full object-cover" />}
      {count > 1 && (
        <div className="absolute top-1 right-1 bg-accent text-button-text text-xs font-bold px-2 py-0.5 rounded-full shadow-md z-10">
          {count}
        </div>
      )}
    </div>
  );
}

function App() {
  const [activeImageDragItem, setActiveImageDragItem] = useState<{ path: string; paths: string[] } | null>(null);

  const { appSettings, theme, osPlatform, handleSettingsChange } = useSettingsStore(
    useShallow((state) => ({
      appSettings: state.appSettings,
      theme: state.theme,
      osPlatform: state.osPlatform,
      handleSettingsChange: state.handleSettingsChange,
    })),
  );

  const {
    isFullScreen,
    isWindowFullScreen,
    isInstantTransition,
    isLayoutReady,
    uiVisibility,
    leftPanelWidth,
    rightPanelWidth,
    compactEditorPanelHeightOverride,
    activePanel,
    activeLayoutDragItem,
    isSettingsOpen,
    setUI,
    setPanel,
    setLayoutDragItem,
    movePanel,
  } = useUIStore(
    useShallow((state) => ({
      isFullScreen: state.isFullScreen,
      isWindowFullScreen: state.isWindowFullScreen,
      isInstantTransition: state.isInstantTransition,
      isLayoutReady: state.isLayoutReady,
      uiVisibility: state.uiVisibility,
      leftPanelWidth: state.leftPanelWidth,
      rightPanelWidth: state.rightPanelWidth,
      compactEditorPanelHeightOverride: state.compactEditorPanelHeightOverride,
      activePanel: state.activePanel,
      activeLayoutDragItem: state.activeLayoutDragItem,
      isSettingsOpen: state.isSettingsOpen,
      setUI: state.setUI,
      setPanel: state.setPanel,
      setLayoutDragItem: state.setLayoutDragItem,
      movePanel: state.movePanel,
    })),
  );

  // MCP control-server bridge (D-020). Mounted at app level so `/op` works
  // before a file is open (Phase 4 note in docs/04) — was in Editor, which only
  // renders in the editor view. Single mount: do NOT also call it in Editor.
  useChromaControl();
  // D-037: debounced project.json + grade + thumb autosave once a project is loaded
  useProjectAutosave();
  // D-051: bridge useEditorStore's grade history into @chroma/history (shell
  // global undo/redo) — single mount, same rationale as the two above.
  useColoristHistoryBridge();

  const { multiSelectedPaths } = useLibraryStore(
    useShallow((state) => ({
      multiSelectedPaths: state.multiSelectedPaths,
    })),
  );

  const { selectedImage, activeMaskContainerId, activeAiPatchContainerId, hasRenderedFirstFrame, setEditor } =
    useEditorStore(
      useShallow((state) => ({
        selectedImage: state.selectedImage,
        activeMaskContainerId: state.activeMaskContainerId,
        activeAiPatchContainerId: state.activeAiPatchContainerId,
        hasRenderedFirstFrame: state.hasRenderedFirstFrame,
        setEditor: state.setEditor,
      })),
    );

  const { exportState, setExportState } = useProcessStore(
    useShallow((state) => ({
      exportState: state.exportState,
      setExportState: state.setExportState,
    })),
  );

  const defaultThumbnailSize = osPlatform === 'android' ? ThumbnailSize.Small : ThumbnailSize.Medium;

  const selectedImagePathRef = useRef<string | null>(null);
  useEffect(() => {
    selectedImagePathRef.current = selectedImage?.path ?? null;
  }, [selectedImage?.path]);

  const prevAdjustmentsRef = useRef<any>(null);

  const [viewportSize, setViewportSize] = useState<ImageDimensions>(() => {
    if (typeof window === 'undefined') {
      return { width: 0, height: 0 };
    }

    return {
      width: Math.round(window.visualViewport?.width ?? window.innerWidth),
      height: Math.round(window.visualViewport?.height ?? window.innerHeight),
    };
  });

  const isBackendReadyRef = useRef(true);
  const previewJobIdRef = useRef<number>(0);
  const latestRenderedJobIdRef = useRef<number>(0);
  const currentResRef = useRef<number>(1280);
  const cachedEditStateRef = useRef<any | null>(null);

  const [isResizing, setIsResizing] = useState(false);
  const [thumbnailSize, setThumbnailSize] = useState(defaultThumbnailSize);
  const [thumbnailAspectRatio, setThumbnailAspectRatio] = useState(ThumbnailAspectRatio.Cover);

  const { requestThumbnails, clearThumbnailQueue, markGenerated } = useThumbnails();

  const transformWrapperRef = useRef<any>(null);

  useAppInitialization({
    thumbnailSize,
    setThumbnailSize,
    thumbnailAspectRatio,
    setThumbnailAspectRatio,
  });

  const isAndroid = osPlatform === 'android';
  const COMPACT_EDITOR_MAX_WIDTH = 900;
  const ANDROID_COMPACT_MAX_WIDTH = 600;
  const ANDROID_FULL_MIN_WIDTH = 1000;

  const isPortraitViewport = viewportSize.width > 0 && viewportSize.height > viewportSize.width;

  type LayoutMode = 'compact' | 'wide' | 'full';
  const layoutMode: LayoutMode = isAndroid
    ? viewportSize.width >= ANDROID_FULL_MIN_WIDTH
      ? 'full'
      : isPortraitViewport && viewportSize.width < ANDROID_COMPACT_MAX_WIDTH
        ? 'compact'
        : 'wide'
    : isPortraitViewport && viewportSize.width > 0 && viewportSize.width <= COMPACT_EDITOR_MAX_WIDTH
      ? 'compact'
      : 'full';

  const useCompactPanels = layoutMode === 'compact';
  const useWidePanels = layoutMode === 'wide';
  const compactEditorPanelMinHeight = 220;
  const compactEditorPanelMaxHeight =
    viewportSize.height > 0
      ? Math.max(compactEditorPanelMinHeight, Math.min(Math.round(viewportSize.height * 0.85), 850))
      : 520;

  const getDynamicCompactPanelHeight = () => {
    const { originalSize, adjustments } = useEditorStore.getState();
    const halfScreenHeight = viewportSize.height > 0 ? Math.round(viewportSize.height * 0.5) : 340;

    if (!selectedImage || originalSize.width === 0 || originalSize.height === 0 || viewportSize.width === 0) {
      return halfScreenHeight;
    }
    let effectiveRatio = originalSize.width / originalSize.height;
    const orientationSteps = adjustments?.orientationSteps || 0;
    if (orientationSteps % 2 !== 0) {
      effectiveRatio = originalSize.height / originalSize.width;
    }
    if (adjustments?.aspectRatio && adjustments.aspectRatio > 0) {
      effectiveRatio = adjustments.aspectRatio;
    }
    const desiredImageHeight = viewportSize.width / effectiveRatio;
    const topUiEstimation = !appSettings?.decorations && !isWindowFullScreen ? 110 : 60;
    const totalDesiredTopHeight = desiredImageHeight + topUiEstimation;
    const calculatedBottomHeight = Math.round(viewportSize.height - totalDesiredTopHeight);
    return Math.max(halfScreenHeight, calculatedBottomHeight);
  };

  const compactEditorPanelDefaultHeight = getDynamicCompactPanelHeight();
  const compactEditorPanelHeight = Math.max(
    compactEditorPanelMinHeight,
    Math.min(compactEditorPanelHeightOverride ?? compactEditorPanelDefaultHeight, compactEditorPanelMaxHeight),
  );
  const compactEditorPanelCollapsedHeight = 96;

  const { handleCopyAdjustments, handlePasteAdjustments, handleResetAdjustments, handleZoomChange } =
    useEditorActions();

  const navigationRefs = {
    transformWrapperRef,
    cachedEditStateRef,
    selectedImagePathRef,
    isBackendReadyRef,
    latestRenderedJobIdRef,
    previewJobIdRef,
    currentResRef,
    prevAdjustmentsRef,
  };

  const { handleImageSelect } = useAppNavigation({
    clearThumbnailQueue,
    refs: navigationRefs,
  });

  const {
    externalEditSession,
    isFinishing: isExternalEditFinishing,
    finishExternalEdit,
  } = useExternalEditSession(handleImageSelect);

  const { handleRate, handleClearSelection, handleLibraryImageSingleClick, handleImageClick, handleSetColorLabel } =
    useLibraryActions(handleImageSelect);

  const { displayList: sortedImageList, badges: groupBadgeInfo } = useSortedLibrary();

  // D-043: this used to reload the current library folder/album after a save
  // elsewhere in the app (panorama/HDR/focus-stack/denoise/collage, delete, rename).
  // There is no library view to refresh any more — kept as a no-op so those call
  // sites don't need their own special-casing (see docs/notes/colorist-strip.md §6).
  const noOpRefresh = useCallback(async () => {}, []);

  const { executeDelete, handleDeleteSelected, handleSaveRename, handleRenameFiles } = useFileOperations(
    noOpRefresh,
    handleImageSelect,
    sortedImageList,
  );

  const {
    handleStartPanorama,
    handleSavePanorama,
    handleStartHdr,
    handleSaveHdr,
    handleApplyDenoise,
    handleBatchDenoise,
    handleSaveDenoisedImage,
    handleSaveCollage,
    handleStartFocusStack,
    handleSaveFocusStack,
  } = useProductivityActions(noOpRefresh);

  const { handleEditorContextMenu, handleThumbnailContextMenu } = useAppContextMenus({
    handleImageSelect,
    handleRenameFiles,
    refreshImageList: noOpRefresh,
    executeDelete,
  });

  useTauriListeners({
    markGenerated,
  });

  useAndroidBackHandler();

  const handleToggleFullScreen = useCallback(() => {
    const { zoom, selectedImage } = useEditorStore.getState();
    const currentlyZoomed = zoom > 1.01;
    setUI({ isInstantTransition: currentlyZoomed });

    if (isFullScreen) {
      setUI({ isFullScreen: false });
    } else {
      if (!selectedImage) return;
      setUI({ isFullScreen: true });
    }

    if (currentlyZoomed) {
      setTimeout(() => setUI({ isInstantTransition: false }), 100);
    }
  }, [isFullScreen, setUI]);

  useKeyboardShortcuts({
    sortedImageList,
    handleDeleteSelected,
    handleImageSelect,
    handleToggleFullScreen,
    handleZoomChange,
  });

  useEffect(() => {
    if (typeof window === 'undefined') return;

    const updateViewportSize = () => {
      const nextViewportSize = {
        width: Math.round(window.visualViewport?.width ?? window.innerWidth),
        height: Math.round(window.visualViewport?.height ?? window.innerHeight),
      };

      setViewportSize((prev) =>
        prev.width === nextViewportSize.width && prev.height === nextViewportSize.height ? prev : nextViewportSize,
      );
    };

    updateViewportSize();

    window.addEventListener('resize', updateViewportSize);
    window.addEventListener('orientationchange', updateViewportSize);
    window.visualViewport?.addEventListener('resize', updateViewportSize);

    return () => {
      window.removeEventListener('resize', updateViewportSize);
      window.removeEventListener('orientationchange', updateViewportSize);
      window.visualViewport?.removeEventListener('resize', updateViewportSize);
    };
  }, []);

  useEffect(() => {
    const handleGlobalContextMenu = (event: MouseEvent) => {
      event.preventDefault();
    };
    window.addEventListener('contextmenu', handleGlobalContextMenu);
    return () => window.removeEventListener('contextmenu', handleGlobalContextMenu);
  }, []);

  const isLightTheme = useMemo(() => [Theme.Light, Theme.Snow, Theme.Arctic].includes(theme as Theme), [theme]);

  useEffect(() => {
    if (
      (activePanel !== Panel.Masks || !activeMaskContainerId) &&
      (activePanel !== Panel.Ai || !activeAiPatchContainerId)
    ) {
      setEditor({ isMaskControlHovered: false });
    }
  }, [activePanel, activeMaskContainerId, activeAiPatchContainerId, setEditor]);

  useEffect(() => {
    const unlisten = listen('ai-connector-status-update', (event: any) => {
      setEditor({ isAIConnectorConnected: event.payload.connected });
    });
    invoke(Invokes.CheckAIConnectorStatus);
    const interval = setInterval(() => invoke(Invokes.CheckAIConnectorStatus), 10000);
    return () => {
      clearInterval(interval);
      safeUnlisten(unlisten);
    };
  }, [setEditor]);

  const createResizeHandler = (stateKey: string, startSize: number) => (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    setIsResizing(true);

    const pointerId = e.pointerId;
    const target = e.currentTarget;
    const startX = e.clientX;
    const startY = e.clientY;

    const previousTouchAction = document.documentElement.style.touchAction;
    const previousUserSelect = document.documentElement.style.userSelect;

    target.setPointerCapture?.(pointerId);
    document.documentElement.style.touchAction = 'none';
    document.documentElement.style.userSelect = 'none';

    const doDrag = (moveEvent: PointerEvent) => {
      if (moveEvent.pointerId !== pointerId) return;
      moveEvent.preventDefault();

      if (stateKey === 'left') {
        let w = startSize + (moveEvent.clientX - startX);
        if (w < 200) {
          setUI((state) => ({ uiVisibility: { ...state.uiVisibility, leftPanel: false } }));
        } else {
          w = Math.min(w, 600);
          setUI((state) => ({
            leftPanelWidth: Math.round(w),
            uiVisibility: { ...state.uiVisibility, leftPanel: true },
          }));
        }
      } else if (stateKey === 'right') {
        let w = startSize - (moveEvent.clientX - startX);
        if (w < 200) {
          setUI((state) => ({ uiVisibility: { ...state.uiVisibility, rightPanel: false } }));
        } else {
          w = Math.min(w, 600);
          setUI((state) => ({
            rightPanelWidth: Math.round(w),
            uiVisibility: { ...state.uiVisibility, rightPanel: true },
          }));
        }
      } else if (stateKey === 'bottom') {
        const newHeight = startSize - (moveEvent.clientY - startY);
        if (newHeight < 100) {
          setUI((state) => ({
            uiVisibility: { ...state.uiVisibility, filmstrip: false },
          }));
        } else {
          setUI((state) => ({
            bottomPanelHeight: Math.round(Math.min(newHeight, 400)),
            uiVisibility: { ...state.uiVisibility, filmstrip: true },
          }));
        }
      } else if (stateKey === 'compact') {
        setUI({
          compactEditorPanelHeightOverride: Math.round(
            Math.max(
              compactEditorPanelMinHeight,
              Math.min(startSize - (moveEvent.clientY - startY), compactEditorPanelMaxHeight),
            ),
          ),
        });
      }
    };

    const stopDrag = (upEvent: PointerEvent) => {
      if (upEvent.pointerId !== pointerId) return;
      if (target.hasPointerCapture?.(pointerId)) target.releasePointerCapture(pointerId);

      document.documentElement.style.cursor = '';
      document.documentElement.style.touchAction = previousTouchAction;
      document.documentElement.style.userSelect = previousUserSelect;

      window.removeEventListener('pointermove', doDrag);
      window.removeEventListener('pointerup', stopDrag);
      window.removeEventListener('pointercancel', stopDrag);
      setIsResizing(false);
    };

    document.documentElement.style.cursor =
      stateKey === 'bottom' || stateKey === 'compact' ? 'row-resize' : 'col-resize';

    window.addEventListener('pointermove', doDrag, { passive: false });
    window.addEventListener('pointerup', stopDrag);
    window.addEventListener('pointercancel', stopDrag);
  };

  const createResizeResetHandler = (stateKey: string) => () => {
    if (stateKey === 'left') {
      setUI((state) => ({
        leftPanelWidth: DEFAULT_PANEL_WIDTH,
        uiVisibility: { ...state.uiVisibility, leftPanel: true },
      }));
    } else if (stateKey === 'right') {
      setUI((state) => ({
        rightPanelWidth: DEFAULT_PANEL_WIDTH,
        uiVisibility: { ...state.uiVisibility, rightPanel: true },
      }));
    } else if (stateKey === 'bottom') {
      setUI((state) => ({
        bottomPanelHeight: DEFAULT_BOTTOM_PANEL_HEIGHT,
        uiVisibility: { ...state.uiVisibility, filmstrip: true },
      }));
    } else if (stateKey === 'compact') {
      setUI({ compactEditorPanelHeightOverride: null });
    }
  };

  useEffect(() => {
    const appWindow = getCurrentWindow();
    const checkFullscreen = async () => {
      setUI({ isWindowFullScreen: await appWindow.isFullscreen() });
    };
    checkFullscreen();
    const unlistenPromise = appWindow.onResized(checkFullscreen);
    return () => {
      safeUnlisten(unlistenPromise);
    };
  }, [setUI]);

  const handlePanelSelect = useCallback(
    (panelId: Panel) => {
      setPanel(panelId);
      setEditor({
        activeMaskId: null,
        activeAiSubMaskId: null,
        isWbPickerActive: false,
        activeRelightLightId: null, // D-046
      });
    },
    [setPanel, setEditor],
  );

  const renderAppPanel = useCallback(
    (panelId: Panel) => {
      switch (panelId) {
        case Panel.Export:
          return (
            <ExportPanel
              exportState={exportState}
              multiSelectedPaths={multiSelectedPaths}
              selectedImage={selectedImage}
              setExportState={setExportState}
              appSettings={appSettings}
              onSettingsChange={handleSettingsChange}
              rootPaths={[]}
              isVisible={true}
              onClose={() => setUI({ isLibraryExportPanelVisible: false })}
            />
          );
        case Panel.Adjustments:
          return <Controls />;
        case Panel.Metadata:
          return <MetadataPanel />;
        case Panel.Crop:
          return <CropPanel />;
        case Panel.Masks:
          return <MasksPanel />;
        case Panel.Relight:
          return <RelightPanel />;
        case Panel.Ai:
          return <AIPanel />;
        case Panel.Presets:
          return <PresetsPanel />;
        case Panel.Tethering:
          return <TetheringPanel onLibraryRefresh={noOpRefresh} onImageSelect={handleImageSelect} />;
        default:
          return null;
      }
    },
    [
      setUI,
      exportState,
      multiSelectedPaths,
      selectedImage,
      setExportState,
      appSettings,
      handleSettingsChange,
      noOpRefresh,
      handleImageSelect,
    ],
  );

  // D-043: the Colorist tab has no folder-tree "Sources" panel any more — the
  // editor pane is unconditional on a selected shot (see docs/notes/colorist-strip.md §6).
  const hasMainContent = !!selectedImage;

  const shouldHideLeftPanel = useCompactPanels || useWidePanels;
  const isWgpuActive =
    appSettings?.useWgpuRenderer !== false &&
    selectedImage?.isReady &&
    hasRenderedFirstFrame;

  // B-006: mirror isWgpuActive up to @chroma/shell so its root also drops its
  // own opaque background — see Shell.tsx's root class + the comment there.
  // Without this the shell's `bg-bg-primary` (added by D-039, sitting *above*
  // this component in the DOM) blocks the transparent "hole" below from ever
  // reaching the real OS window, so the native wgpu surface never shows
  // through no matter how correctly it renders.
  useEffect(() => {
    useShellStore.getState().setWgpuSurfaceActive(!!isWgpuActive);
    return () => useShellStore.getState().setWgpuSurfaceActive(false);
  }, [isWgpuActive]);

  const layoutSensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));
  const handleDragStart = (e: any) => {
    if (e.active.data.current?.type === 'layout-tab') {
      setLayoutDragItem(e.active.data.current.panel as Panel);
    } else if (e.active.data.current?.type === 'library-image') {
      const path = e.active.data.current.path;
      const multiSelected = useLibraryStore.getState().multiSelectedPaths;
      const paths = multiSelected.includes(path) ? multiSelected : [path];
      setActiveImageDragItem({ path, paths });
    }
  };

  const handleDragEnd = (e: any) => {
    setLayoutDragItem(null);
    setActiveImageDragItem(null);
    const { active, over } = e;

    if (active.data.current?.type === 'layout-tab' && over?.data.current?.type === 'layout-region') {
      movePanel(active.data.current.panel as Panel, over.data.current.region as PanelRegion);
    }
  };

  const ActiveOverlayIcon = activeLayoutDragItem ? PANEL_ICONS[activeLayoutDragItem] : null;
  const effectiveLeftWidth = uiVisibility.leftPanel ? leftPanelWidth : 48;
  const effectiveRightWidth = uiVisibility.rightPanel ? rightPanelWidth : useWidePanels ? 58 : 48;

  return (
    <>
      <ImageProcessingManager
        transformWrapperRef={transformWrapperRef}
        prevAdjustmentsRef={prevAdjustmentsRef}
        previewJobIdRef={previewJobIdRef}
        latestRenderedJobIdRef={latestRenderedJobIdRef}
        currentResRef={currentResRef}
      />
      <ImageLoaderManager cachedEditStateRef={cachedEditStateRef} />
      <div
        className={clsx(
          // h-full (not h-screen): the Colorist app is mounted inside a tab of @chroma/shell (D-039),
          // so it must fill the tab content area, not the whole viewport.
          'flex flex-col h-full font-sans text-text-primary overflow-hidden select-none',
          // D-039: `.macos-window-shell` (14px rounded corners) is on the @chroma/shell
          // root now — the whole window is the shell's, the Colorist app fills a tab.
          isWgpuActive ? 'bg-transparent' : 'bg-bg-primary',
        )}
      >
        {/* D-039: window chrome (the title bar) moved to @chroma/shell — it now
            sits above all three tabs, not inside the Colorist tab.
            `app/src/window/TitleBar.tsx` stays unrouted for reference. */}
        <div
          className={clsx(
            'flex-1 flex flex-col min-h-0',
            isLayoutReady && hasMainContent && !isInstantTransition && 'transition-all duration-300 ease-in-out',
            [hasMainContent && (isFullScreen ? 'p-0 gap-0' : 'p-2 gap-2')],
          )}
        >
          <DndContext
            sensors={layoutSensors}
            onDragStart={handleDragStart}
            onDragEnd={handleDragEnd}
            collisionDetection={pointerWithin}
            measuring={{
              droppable: {
                strategy: MeasuringStrategy.Always,
              },
            }}
          >
            <div className="flex flex-row grow h-full min-h-0">
              {!shouldHideLeftPanel && hasMainContent && (
                <SidePanelArea
                  side="left"
                  width={effectiveLeftWidth}
                  topRegion="leftTop"
                  bottomRegion="leftBottom"
                  renderPanel={renderAppPanel}
                  onWidthChange={createResizeHandler('left', effectiveLeftWidth)}
                  onWidthReset={createResizeResetHandler('left')}
                  isResizing={isResizing}
                />
              )}
              <div className="relative flex-1 flex flex-col min-w-0">
                {selectedImage && externalEditSession && (
                  <ExternalEditBar
                    session={externalEditSession}
                    isFinishing={isExternalEditFinishing}
                    errorMessage={exportState.status === Status.Error ? exportState.errorMessage : ''}
                    onDone={finishExternalEdit}
                  />
                )}
                <div
                  className={clsx('flex-1 flex flex-col min-w-0 h-full', selectedImage ? 'flex' : 'hidden')}
                >
                  {selectedImage && (
                    <EditorView
                      transformWrapperRef={transformWrapperRef}
                      isResizing={isResizing}
                      layoutMode={layoutMode}
                      isAndroid={isAndroid}
                      compactEditorPanelHeight={compactEditorPanelHeight}
                      compactEditorPanelCollapsedHeight={compactEditorPanelCollapsedHeight}
                      thumbnailAspectRatio={thumbnailAspectRatio}
                      sortedImageList={sortedImageList}
                      createResizeHandler={createResizeHandler}
                      createResizeResetHandler={createResizeResetHandler}
                      handleEditorContextMenu={handleEditorContextMenu}
                      handleThumbnailContextMenu={handleThumbnailContextMenu}
                      handleImageClick={handleImageClick}
                      handleClearSelection={handleClearSelection}
                      handleCopyAdjustments={handleCopyAdjustments}
                      handlePasteAdjustments={handlePasteAdjustments}
                      handleRate={handleRate}
                      handleZoomChange={handleZoomChange}
                      handlePanelSelect={handlePanelSelect}
                      requestThumbnails={requestThumbnails}
                      renderAppPanel={renderAppPanel}
                    />
                  )}
                </div>
                <div
                  className={clsx('flex-1 flex flex-col min-w-0 h-full', selectedImage ? 'hidden' : 'flex')}
                >
                  {/* D-043: RapidRAW's welcome/library/community view is gone — the
                      Colorist tab is the grading editor only. A project with no
                      selected shot (or every shot offline) lands here; "no project
                      at all" is handled one level up by the shell launcher. */}
                  <ColoristEmptyState />
                </div>
                {isSettingsOpen && appSettings && (
                  <div className="absolute inset-0 z-50 flex bg-bg-secondary rounded-lg">
                    <div className="w-full h-full flex flex-col p-4 lg:p-8 overflow-y-auto custom-scrollbar">
                      <SettingsPanel
                        appSettings={appSettings}
                        onBack={() => setUI({ isSettingsOpen: false })}
                        onSettingsChange={handleSettingsChange}
                      />
                    </div>
                  </div>
                )}
              </div>
              {!useCompactPanels && hasMainContent && (
                <SidePanelArea
                  side="right"
                  width={effectiveRightWidth}
                  topRegion="rightTop"
                  bottomRegion="rightBottom"
                  renderPanel={renderAppPanel}
                  onWidthChange={createResizeHandler('right', effectiveRightWidth)}
                  onWidthReset={createResizeResetHandler('right')}
                  isResizing={isResizing}
                  showAdditionalTabs={useWidePanels}
                />
              )}
            </div>
            <DragOverlay modifiers={activeImageDragItem ? [imageDragModifier] : undefined} dropAnimation={null}>
              {activeLayoutDragItem && ActiveOverlayIcon ? (
                <div className="w-10 h-10 bg-surface shadow-2xl rounded-md flex items-center justify-center text-text-primary ring-1 ring-border-color">
                  <ActiveOverlayIcon size={20} />
                </div>
              ) : null}
              {activeImageDragItem ? <ImageDragOverlayNode activeItem={activeImageDragItem} /> : null}
            </DragOverlay>
          </DndContext>
        </div>
        <AppModals
          handleImageSelect={handleImageSelect}
          handleSavePanorama={handleSavePanorama}
          handleStartPanorama={handleStartPanorama}
          handleStartFocusStack={handleStartFocusStack}
          handleSaveFocusStack={handleSaveFocusStack}
          handleSaveHdr={handleSaveHdr}
          handleStartHdr={handleStartHdr}
          refreshImageList={noOpRefresh}
          handleApplyDenoise={handleApplyDenoise}
          handleBatchDenoise={handleBatchDenoise}
          handleSaveDenoisedImage={handleSaveDenoisedImage}
          handleSaveRename={handleSaveRename}
          handleSetColorLabel={handleSetColorLabel}
          handleRate={handleRate}
          executeDelete={executeDelete}
          handleSaveCollage={handleSaveCollage}
        />
        {/* Chroma: the agent activity feed + request_human banner (D-032) */}
        <AgentActivityDock />
        <ToastContainer
          position="bottom-right"
          autoClose={5000}
          hideProgressBar={false}
          newestOnTop
          closeOnClick
          rtl={false}
          pauseOnFocusLoss
          draggable={false}
          pauseOnHover
          theme={isLightTheme ? 'light' : 'dark'}
          transition={Slide}
          toastClassName={() =>
            clsx(
              'relative flex min-h-16 p-4 rounded-lg justify-between overflow-hidden cursor-pointer mb-4',
              'bg-surface! text-text-primary! border! border-border-color! shadow-2xl! max-w-[420px]!',
            )
          }
        />
      </div>
    </>
  );
}

const AppWrapper = () => (
  <ContextMenuProvider>
    <App />
    <GlobalTooltip />
  </ContextMenuProvider>
);

export default AppWrapper;
