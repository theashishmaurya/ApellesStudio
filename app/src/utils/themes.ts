import { cssVariablesFor } from '@apelles/tokens';
import { Theme } from '../components/ui/AppProperties';

export interface ThemeProps {
  cssVariables: any;
  id: Theme;
  name: string;
  splashImage: string;
}

/**
 * D-432 P1: the colour VALUES live in `@apelles/tokens` (the one token source);
 * this file only pairs each theme with its id, label key and splash image.
 */
export const THEMES: Array<ThemeProps> = [
  {
    id: Theme.Dark,
    name: 'settings.themes.dark',
    splashImage: '/splash-dark.jpg',
    cssVariables: cssVariablesFor('dark'),
  },
  {
    id: Theme.Light,
    name: 'settings.themes.light',
    splashImage: '/splash-light.jpg',
    cssVariables: cssVariablesFor('light'),
  },
  {
    id: Theme.Grey,
    name: 'settings.themes.grey',
    splashImage: '/splash-grey.jpg',
    cssVariables: cssVariablesFor('grey'),
  },
];

export const DEFAULT_THEME_ID = Theme.Dark;
