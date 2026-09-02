// D-043: the Colorist tab's empty state — shown when a project is open but no
// shot is selected (or every shot is offline). Replaces RapidRAW's inherited
// "Welcome back / Continue Session / Add Folder" library splash. No project at
// all is handled one level up by the shell launcher (`main.tsx`).
import { Clapperboard } from 'lucide-react';
import { useTranslation } from 'react-i18next';

export default function ColoristEmptyState() {
  const { t } = useTranslation();
  return (
    <div className="flex-1 flex flex-col items-center justify-center gap-4 bg-bg-primary rounded-lg select-none text-center px-8">
      <Clapperboard size={48} className="text-text-secondary opacity-40" strokeWidth={1.5} />
      <p className="text-lg font-medium text-text-secondary">
        {t('colorist.emptyState.title', 'Add or select a shot to start grading')}
      </p>
      <p className="text-sm text-text-secondary opacity-70 max-w-sm">
        {t('colorist.emptyState.hint', 'Use the shot strip below, or drop a clip onto the window.')}
      </p>
    </div>
  );
}
