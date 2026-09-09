import { useRef, useState } from 'react';
import { ChevronDown, Eye, EyeOff } from 'lucide-react';
import clsx from 'clsx';
import Text from './Text';
import { TextVariants, TextWeights } from './typography';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from './components/ui/collapsible';

interface CollapsibleSectionProps {
  canToggleVisibility?: boolean;
  children: any;
  isContentVisible?: boolean;
  isOpen: boolean;
  onContextMenu?: any;
  onToggle: () => void;
  onToggleVisibility?: () => void;
  title: string;
}

/**
 * `CollapsibleSection` — RapidRAW's titled, optionally-hideable accordion panel,
 * rebuilt on the shadcn/Base-UI `Collapsible` (D-042). Base UI drives the
 * open/close height transition (`--collapsible-panel-height`), replacing the
 * hand-rolled `ResizeObserver` + `maxHeight` animation.
 *
 * Props + behaviour are unchanged, so the `app/src/components/ui/CollapsibleSection.tsx`
 * shim and its call sites are untouched. The two visibility-toggle tooltips are
 * still inlined in English (`@apelles/ui` does not pull `react-i18next`).
 */
export default function CollapsibleSection({
  canToggleVisibility = true,
  children,
  isContentVisible = true,
  isOpen,
  onContextMenu,
  onToggle,
  onToggleVisibility = () => {},
  title,
}: CollapsibleSectionProps) {
  const [isHovering, setIsHovering] = useState(false);
  const hoverTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const handleMouseEnter = () => {
    if (!canToggleVisibility) {
      return;
    }
    hoverTimeoutRef.current = setTimeout(() => setIsHovering(true), 250);
  };

  const handleMouseLeave = () => {
    if (hoverTimeoutRef.current) {
      clearTimeout(hoverTimeoutRef.current);
      hoverTimeoutRef.current = null;
    }
    setIsHovering(false);
  };

  const handleVisibilityClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    onToggleVisibility();
  };

  return (
    <Collapsible
      open={isOpen}
      onOpenChange={() => onToggle()}
      className="bg-surface rounded-lg overflow-hidden shrink-0 block"
      onContextMenu={onContextMenu}
    >
      <CollapsibleTrigger
        // rendered as a div (not the default <button>) so the visibility <button>
        // can nest inside it — matches the RapidRAW original's markup
        render={<div role="button" tabIndex={0} />}
        className="w-full px-4 py-3 flex items-center justify-between text-left cursor-pointer hover:bg-card-active transition-colors duration-200"
        onMouseEnter={handleMouseEnter}
        onMouseLeave={handleMouseLeave}
      >
        <div className="flex items-center gap-2">
          <Text variant={TextVariants.title} weight={TextWeights.normal}>
            {title}
          </Text>
          {canToggleVisibility && (
            <div className="w-6 h-6 flex items-center justify-center">
              <button
                type="button"
                className={clsx(
                  'p-1 rounded-full text-text-secondary hover:bg-bg-primary z-10 transition-opacity duration-300',
                  isHovering || !isContentVisible ? 'opacity-100' : 'opacity-0 pointer-events-none',
                )}
                onClick={handleVisibilityClick}
                data-tooltip={isContentVisible ? 'Disable Section' : 'Enable Section'}
              >
                {isContentVisible ? <Eye size={16} /> : <EyeOff size={16} />}
              </button>
            </div>
          )}
        </div>
        <ChevronDown
          className={clsx('text-accent transition-transform duration-300', { 'rotate-180': isOpen })}
          size={20}
        />
      </CollapsibleTrigger>
      <CollapsibleContent className="overflow-hidden transition-[height] duration-300 ease-in-out h-[var(--collapsible-panel-height)] data-[starting-style]:h-0 data-[ending-style]:h-0">
        <div
          className={clsx(
            'px-4 pb-4 pt-0 transition-opacity duration-300',
            !isContentVisible && 'opacity-30 pointer-events-none',
          )}
        >
          {children}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}
