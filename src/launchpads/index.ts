import type { Launchpad } from './types';
import { pump } from './pump';
import { bonk } from './bonk';

export const LAUNCHPADS: Launchpad[] = [pump, bonk];

export function padById(id: string): Launchpad {
  return LAUNCHPADS.find((p) => p.id === id) ?? LAUNCHPADS[0];
}
