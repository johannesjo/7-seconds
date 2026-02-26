import { MissionDef } from './types';

export const MISSIONS: MissionDef[] = [
  {
    id: 1,
    name: 'First Contact',
    description: 'Engage a small enemy patrol. 4 soldiers vs 6 enemy soldiers.',
    blueArmy: [{ type: 'soldier', count: 4 }],
    redArmy: [{ type: 'soldier', count: 6 }],
    redStatic: true,
  },
  {
    id: 2,
    name: 'Hold the Line',
    description: 'Enemy armor spotted. 4 soldiers vs 4 soldiers and 4 tanks.',
    blueArmy: [{ type: 'soldier', count: 4 }],
    redArmy: [
      { type: 'soldier', count: 4 },
      { type: 'tank', count: 4 },
    ],
    redStatic: true,
  },
  {
    id: 3,
    name: 'Final Push',
    description: 'Full assault. 3 soldiers and 1 sniper vs a fortified position.',
    blueArmy: [
      { type: 'soldier', count: 3 },
      { type: 'sniper', count: 1 },
    ],
    redArmy: [
      { type: 'soldier', count: 5 },
      { type: 'tank', count: 3 },
      { type: 'sniper', count: 2 },
    ],
    redStatic: true,
  },
];
