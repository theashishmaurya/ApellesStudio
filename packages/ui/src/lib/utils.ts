import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

/**
 * `cn` — the canonical shadcn class merge: clsx for conditional composition,
 * tailwind-merge to resolve conflicting Tailwind utilities (last wins).
 * D-042. Every component in this kit builds its className with this.
 */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
