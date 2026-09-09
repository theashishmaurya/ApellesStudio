// Apelles — the canvas ROI rectangle for a pending `request_human(reason, roi)`
// (D-032). Rendered inside ImageCanvas's absolute overlay layer, so it uses the
// same coordinate space as the mask overlay (imageRenderSize offsets/size).
import { useAgentStore } from '../../store/useAgentStore';
import { RenderSize } from '../../hooks/useImageRenderSize';

interface Props {
  imageRenderSize: RenderSize;
  isMaxZoom?: boolean;
}

export default function AgentRoiHighlight({ imageRenderSize, isMaxZoom }: Props) {
  const req = useAgentStore((s) => s.pendingHumanRequest);
  const roi = req && !req.cleared ? req.roi : null;

  if (!roi || imageRenderSize.width <= 0 || imageRenderSize.height <= 0) return null;

  const left = imageRenderSize.offsetX + roi.x * imageRenderSize.width;
  const top = imageRenderSize.offsetY + roi.y * imageRenderSize.height;
  const width = Math.max(2, roi.w * imageRenderSize.width);
  const height = Math.max(2, roi.h * imageRenderSize.height);

  return (
    <div
      className="absolute pointer-events-none"
      style={{
        left,
        top,
        width,
        height,
        border: '2px solid #f59e0b',
        // dim everything outside the region so the eye lands on it
        boxShadow: '0 0 0 9999px rgba(0,0,0,0.35)',
        borderRadius: 2,
        zIndex: 4,
        imageRendering: isMaxZoom ? 'pixelated' : 'auto',
      }}
    >
      <span
        className="absolute -top-5 left-0 px-1.5 py-0.5 rounded-sm text-[10px] font-semibold whitespace-nowrap"
        style={{ background: '#f59e0b', color: '#1a1a1a' }}
      >
        agent asks for a look
      </span>
    </div>
  );
}
