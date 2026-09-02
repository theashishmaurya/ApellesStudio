// Interactive relight (D-046) — the draggable light pucks on the Colorist
// preview canvas. Mirrors the existing HTML-marker overlay pattern already
// used for clone/heal source markers in this file (`directPatchMarkers`,
// `ImageCanvas.tsx`): an `absolute inset-0 pointer-events-none` div holding
// `pointer-events-auto` circles positioned via
// `(imageSpace - crop) * imageRenderSize.scale + imageRenderSize.offsetX/Y`.
// This is the *canvas-overlay + drag-state* pattern the brief asked to reuse —
// the Konva radial/linear mask-shape tree (drag + resize + rotate transform)
// is a different, heavier interaction model built for shape geometry with a
// bounding-box handle; a light puck is a plain draggable point + a
// non-interactive falloff-radius ring, closer to the marker overlay already
// here than to a Konva `<Transformer>`-backed shape.
//
// Position (x/y) drags natively (pointer capture, screen<->image-space via
// `imageRenderSize`); falloff radius is a side-panel control (RelightPanel),
// per the ClipDrop-Relight interaction the brief specifies ("drag = position,
// a control = falloff radius").
import { useCallback, useRef } from 'react';
import type { RelightLight } from '../../../utils/adjustments';
import type { RenderSize } from '../../../hooks/useImageRenderSize';

interface RelightPuckLayerProps {
  lights: RelightLight[];
  imageRenderSize: RenderSize;
  cropX: number;
  cropY: number;
  imageWidth: number;
  imageHeight: number;
  activeLightId: string | null;
  maxSafeScale: number;
  onSelectLight(id: string): void;
  /** Called continuously while dragging (live preview) AND once more on
   *  pointer-up (the committed value) — same "preview during drag, commit on
   *  release" split `onLiveMaskPreview`/`onUpdate` use elsewhere in this file. */
  onDragLight(id: string, xPct: number, yPct: number, committed: boolean): void;
}

export default function RelightPuckLayer({
  lights,
  imageRenderSize,
  cropX,
  cropY,
  imageWidth,
  imageHeight,
  activeLightId,
  maxSafeScale,
  onSelectLight,
  onDragLight,
}: RelightPuckLayerProps) {
  const draggingId = useRef<string | null>(null);

  const screenToImagePct = useCallback(
    (clientX: number, clientY: number, container: HTMLElement) => {
      const rect = container.getBoundingClientRect();
      const localX = clientX - rect.left;
      const localY = clientY - rect.top;
      const imageX = (localX - imageRenderSize.offsetX) / (imageRenderSize.scale || 1) + cropX;
      const imageY = (localY - imageRenderSize.offsetY) / (imageRenderSize.scale || 1) + cropY;
      const xPct = imageWidth > 0 ? (imageX / imageWidth) * 100 : 0;
      const yPct = imageHeight > 0 ? (imageY / imageHeight) * 100 : 0;
      return {
        xPct: Math.min(100, Math.max(0, xPct)),
        yPct: Math.min(100, Math.max(0, yPct)),
      };
    },
    [imageRenderSize, cropX, cropY, imageWidth, imageHeight],
  );

  const handlePointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>, light: RelightLight) => {
      if (e.button !== 0) return;
      e.stopPropagation();
      e.preventDefault();
      onSelectLight(light.id);
      draggingId.current = light.id;
      (e.target as HTMLElement).setPointerCapture(e.pointerId);
    },
    [onSelectLight],
  );

  const handlePointerMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      const id = draggingId.current;
      if (!id) return;
      const container = (e.currentTarget as HTMLElement).closest('[data-relight-surface]') as HTMLElement | null;
      if (!container) return;
      const { xPct, yPct } = screenToImagePct(e.clientX, e.clientY, container);
      onDragLight(id, xPct, yPct, false);
    },
    [screenToImagePct, onDragLight],
  );

  const handlePointerUp = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      const id = draggingId.current;
      if (!id) return;
      draggingId.current = null;
      const container = (e.currentTarget as HTMLElement).closest('[data-relight-surface]') as HTMLElement | null;
      if (container) {
        const { xPct, yPct } = screenToImagePct(e.clientX, e.clientY, container);
        onDragLight(id, xPct, yPct, true);
      }
    },
    [screenToImagePct, onDragLight],
  );

  return (
    <div className="absolute inset-0 pointer-events-none z-40" data-relight-surface>
      {lights
        .filter((l) => l.visible && l.kind !== 'ambient')
        .map((light) => {
          const cx = (((light.x / 100) * imageWidth - cropX) * imageRenderSize.scale) + imageRenderSize.offsetX;
          const cy = (((light.y / 100) * imageHeight - cropY) * imageRenderSize.scale) + imageRenderSize.offsetY;
          const radiusPx =
            (light.radius / 100) * Math.max(imageRenderSize.width, imageRenderSize.height);
          const isActive = light.id === activeLightId;
          const counterScale = 1 / (maxSafeScale || 1);

          return (
            <div key={light.id}>
              {/* Falloff ring — visual feedback only, not interactive. */}
              <div
                className="absolute rounded-full pointer-events-none"
                style={{
                  left: cx,
                  top: cy,
                  width: radiusPx * 2,
                  height: radiusPx * 2,
                  transform: 'translate(-50%, -50%)',
                  border: `1.5px dashed ${light.color}`,
                  opacity: isActive ? 0.55 : 0.25,
                }}
              />
              {/* The draggable puck. */}
              <div
                className="absolute rounded-full pointer-events-auto cursor-grab active:cursor-grabbing shadow-md"
                style={{
                  left: cx,
                  top: cy,
                  width: 18,
                  height: 18,
                  transform: `translate(-50%, -50%) scale(${counterScale})`,
                  transformOrigin: 'center',
                  background: light.color,
                  border: isActive ? '2px solid white' : '1.5px solid rgba(255,255,255,0.7)',
                  boxShadow: isActive
                    ? '0 0 0 2px rgba(0,0,0,0.4), 0 0 8px rgba(0,0,0,0.5)'
                    : '0 0 4px rgba(0,0,0,0.5)',
                }}
                onPointerDown={(e) => handlePointerDown(e, light)}
                onPointerMove={handlePointerMove}
                onPointerUp={handlePointerUp}
                title={light.kind}
              />
            </div>
          );
        })}
    </div>
  );
}
