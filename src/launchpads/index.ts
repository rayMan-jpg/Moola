import type { Launchpad } from './types';

// Temporary stub until the adapters land.
const stub = (id: string, name: string, tagline: string, badge?: string): Launchpad => ({
  id, name, tagline, badge, costHint: 'tiny network fees', overheadSol: 0.03,
  async prepare() { throw new Error('not implemented yet'); },
});

export const LAUNCHPADS: Launchpad[] = [
  stub('pump', 'pump.fun', 'the OG casino', 'MOST APED'),
  stub('bonk', 'Bonk.fun', 'dog szn launchpad'),
  stub('jup', 'Jupiter Studio', 'jup.ag curve'),
];

export function padById(id: string): Launchpad {
  return LAUNCHPADS.find((p) => p.id === id) ?? LAUNCHPADS[0];
}
