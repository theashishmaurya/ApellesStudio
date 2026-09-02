import { useShallow } from 'zustand/react/shallow';
import { useUIStore } from '../../store/useUIStore';
import { useSettingsStore } from '../../store/useSettingsStore';
import { useProcessStore } from '../../store/useProcessStore';
import { useEditorStore } from '../../store/useEditorStore';
import CopyPasteSettingsModal from './CopyPasteSettingsModal';
import PanoramaModal from './PanoramaModal';
import HdrModal from './HdrModal';
import FocusStackModal from './FocusStackModal';
import NegativeConversionModal from './NegativeConversionModal';
import DenoiseModal from './DenoiseModal';
import RenameFileModal from './RenameFileModal';
import ConfirmModal from './ConfirmModal';
import CollageModal from './CollageModal';
import { AppSettings } from '../ui/AppProperties';
import { CopyPasteSettings } from '../../utils/adjustments';

// D-043: this used to also mount the folder-tree "Sources" panel's
// create/rename-folder modals, the album create/rename modals, and the
// import-into-library modal — all removed with FolderTree/LibraryView (see
// docs/notes/colorist-strip.md §6). `RenameFileModal` survives — it renames the
// actively-edited/-selected file(s), independent of any library folder concept.
export interface AppModalsProps {
  handleImageSelect: (path: string) => void;
  handleSavePanorama: () => Promise<string>;
  handleStartPanorama: (paths: string[]) => void;
  handleSaveHdr: () => Promise<string>;
  handleStartHdr: (paths: string[]) => void;
  handleStartFocusStack: (paths: string[]) => void;
  handleSaveFocusStack: () => Promise<string>;
  refreshImageList: () => Promise<void>;
  handleApplyDenoise: (intensity: number, method: 'ai' | 'bm3d') => Promise<void>;
  handleBatchDenoise: (intensity: number, method: 'ai' | 'bm3d', paths: string[]) => Promise<string[]>;
  handleSaveDenoisedImage: () => Promise<string>;
  handleSaveRename: (nameTemplate: string) => Promise<void>;
  handleSetColorLabel: (color: string | null, paths?: string[]) => Promise<void>;
  handleRate: (rating: number, paths?: string[]) => void;
  executeDelete: (paths: string[], options: any) => Promise<void>;
  handleSaveCollage: (base64Data: string, firstPath: string) => Promise<string>;
}

export default function AppModals(props: AppModalsProps) {
  const { appSettings, handleSettingsChange } = useSettingsStore(
    useShallow((state) => ({
      appSettings: state.appSettings,
      handleSettingsChange: state.handleSettingsChange,
    })),
  );

  const {
    isRenameFileModalOpen,
    isCopyPasteSettingsModalOpen,
    renameTargetPaths,
    confirmModalState,
    panoramaModalState,
    hdrModalState,
    focusStackModalState,
    negativeModalState,
    denoiseModalState,
    collageModalState,
    setUI,
  } = useUIStore(
    useShallow((state) => ({
      isRenameFileModalOpen: state.isRenameFileModalOpen,
      isCopyPasteSettingsModalOpen: state.isCopyPasteSettingsModalOpen,
      renameTargetPaths: state.renameTargetPaths,
      confirmModalState: state.confirmModalState,
      panoramaModalState: state.panoramaModalState,
      hdrModalState: state.hdrModalState,
      focusStackModalState: state.focusStackModalState,
      negativeModalState: state.negativeModalState,
      denoiseModalState: state.denoiseModalState,
      collageModalState: state.collageModalState,
      setUI: state.setUI,
    })),
  );

  const { thumbnails, aiModelDownloadStatus } = useProcessStore(
    useShallow((state) => ({
      thumbnails: state.thumbnails,
      aiModelDownloadStatus: state.aiModelDownloadStatus,
    })),
  );

  const { selectedImage, finalPreviewUrl } = useEditorStore(
    useShallow((state) => ({
      selectedImage: state.selectedImage,
      finalPreviewUrl: state.finalPreviewUrl,
    })),
  );

  const closeConfirmModal = () => {
    setUI((state) => ({ confirmModalState: { ...state.confirmModalState, isOpen: false } }));
  };

  return (
    <>
      <CopyPasteSettingsModal
        isOpen={isCopyPasteSettingsModalOpen}
        onClose={() => setUI({ isCopyPasteSettingsModalOpen: false })}
        settings={appSettings?.copyPasteSettings as CopyPasteSettings}
        onSave={(newSettings) =>
          handleSettingsChange({ ...appSettings, copyPasteSettings: newSettings } as AppSettings)
        }
      />
      <PanoramaModal
        error={panoramaModalState.error}
        finalImageBase64={panoramaModalState.finalImageBase64}
        imageCount={panoramaModalState.stitchingSourcePaths.length}
        isOpen={panoramaModalState.isOpen}
        isProcessing={panoramaModalState.isProcessing}
        loadingImageUrl={
          panoramaModalState.stitchingSourcePaths.length > 0
            ? thumbnails[
                panoramaModalState.stitchingSourcePaths[Math.floor(panoramaModalState.stitchingSourcePaths.length / 2)]
              ] || null
            : null
        }
        onClose={() =>
          setUI({
            panoramaModalState: {
              isOpen: false,
              isProcessing: false,
              progressMessage: '',
              finalImageBase64: null,
              error: null,
              stitchingSourcePaths: [],
            },
          })
        }
        onOpenFile={(path: string) => props.handleImageSelect(path)}
        onSave={props.handleSavePanorama}
        onStitch={() => props.handleStartPanorama(panoramaModalState.stitchingSourcePaths)}
        progressMessage={panoramaModalState.progressMessage}
      />
      <HdrModal
        error={hdrModalState.error}
        finalImageBase64={hdrModalState.finalImageBase64}
        imageCount={hdrModalState.stitchingSourcePaths.length}
        isOpen={hdrModalState.isOpen}
        isProcessing={hdrModalState.isProcessing}
        loadingImageUrl={
          hdrModalState.stitchingSourcePaths.length > 0
            ? thumbnails[
                hdrModalState.stitchingSourcePaths[Math.floor(hdrModalState.stitchingSourcePaths.length / 2)]
              ] || null
            : null
        }
        onClose={() =>
          setUI({
            hdrModalState: {
              isOpen: false,
              isProcessing: false,
              progressMessage: '',
              finalImageBase64: null,
              error: null,
              stitchingSourcePaths: [],
            },
          })
        }
        onOpenFile={(path: string) => props.handleImageSelect(path)}
        onSave={props.handleSaveHdr}
        onMerge={() => props.handleStartHdr(hdrModalState.stitchingSourcePaths)}
        progressMessage={hdrModalState.progressMessage}
      />
      <FocusStackModal
        error={focusStackModalState.error}
        finalImageBase64={focusStackModalState.finalImageBase64}
        imageCount={focusStackModalState.sourcePaths.length}
        isOpen={focusStackModalState.isOpen}
        isProcessing={focusStackModalState.isProcessing}
        loadingImageUrl={
          focusStackModalState.sourcePaths.length > 0
            ? thumbnails[focusStackModalState.sourcePaths[Math.floor(focusStackModalState.sourcePaths.length / 2)]] ||
              null
            : null
        }
        depthMapBase64={focusStackModalState.depthMapBase64}
        onClose={() =>
          setUI({
            focusStackModalState: {
              isOpen: false,
              isProcessing: false,
              progressMessage: '',
              finalImageBase64: null,
              depthMapBase64: null,
              error: null,
              sourcePaths: [],
            },
          })
        }
        onOpenFile={(path: string) => props.handleImageSelect(path)}
        onSave={props.handleSaveFocusStack}
        onMerge={() => props.handleStartFocusStack(focusStackModalState.sourcePaths)}
        progressMessage={focusStackModalState.progressMessage}
      />
      <NegativeConversionModal
        isOpen={negativeModalState.isOpen}
        onClose={() => setUI((state) => ({ negativeModalState: { ...state.negativeModalState, isOpen: false } }))}
        targetPaths={negativeModalState.targetPaths}
        onSave={(savedPaths) => {
          props.refreshImageList().then(() => {
            if (selectedImage && negativeModalState.targetPaths.includes(selectedImage.path) && savedPaths.length > 0) {
              props.handleImageSelect(savedPaths[0]);
            }
          });
        }}
      />
      <DenoiseModal
        isOpen={denoiseModalState.isOpen}
        onClose={() => setUI((state) => ({ denoiseModalState: { ...state.denoiseModalState, isOpen: false } }))}
        onDenoise={props.handleApplyDenoise}
        onBatchDenoise={props.handleBatchDenoise}
        onSave={props.handleSaveDenoisedImage}
        onOpenFile={props.handleImageSelect}
        previewBase64={denoiseModalState.previewBase64}
        originalBase64={denoiseModalState.originalBase64 || null}
        isProcessing={denoiseModalState.isProcessing}
        error={denoiseModalState.error}
        progressMessage={denoiseModalState.progressMessage}
        aiModelDownloadStatus={aiModelDownloadStatus}
        isRaw={denoiseModalState.isRaw}
        targetPaths={denoiseModalState.targetPaths}
        loadingImageUrl={
          denoiseModalState.targetPaths.length > 0
            ? thumbnails[denoiseModalState.targetPaths[0]] ||
              (selectedImage?.path === denoiseModalState.targetPaths[0] ? finalPreviewUrl : null)
            : null
        }
      />
      <RenameFileModal
        filesToRename={renameTargetPaths}
        isOpen={isRenameFileModalOpen}
        onClose={() => setUI({ isRenameFileModalOpen: false })}
        onSave={props.handleSaveRename}
      />
      <ConfirmModal {...confirmModalState} onClose={closeConfirmModal} />
      <CollageModal
        isOpen={collageModalState.isOpen}
        onClose={() => setUI({ collageModalState: { isOpen: false, sourceImages: [] } })}
        onSave={props.handleSaveCollage}
        sourceImages={collageModalState.sourceImages}
        thumbnails={thumbnails}
      />
    </>
  );
}
