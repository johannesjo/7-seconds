export interface Theme {
  bg: number;
  grid: number;
  gridAlpha: number;

  // Elevation zones
  elevationOuter: number;
  elevationMid: number;
  elevationInner: number;
  elevationLabel: string;

  // Obstacles
  obstacleBorder: number;
  obstacleFill: number;
  obstacleHighlight: number;

  // Teams
  blue: number;
  blueZombie: number;
  blueDark: number;
  red: number;
  redZombie: number;
  redDark: number;

  // Effects — projectile / impact / kill text
  blueProjectile: number;
  redProjectile: number;
  blueImpact: number;
  redImpact: number;
  blueKill: string;
  redKill: string;

  // Blood colors
  blueBlood: number[];
  redBlood: number[];
  blueStain: number;
  redStain: number;

  // Muzzle flash
  muzzleFlash: number;
  muzzleCore: number;

  // Barrel / nose
  barrel: number;
  barrelAlpha: number;

  // HP bar
  hpBg: number;
  hpHigh: number;
  hpMid: number;
  hpLow: number;

  // Path drawer
  bluePath: number;
  redPath: number;
  bluePathBright: number;
  redPathBright: number;
  labelFill: number;
  labelWarn: number;
  elevationBonus: number;
  hoverLabelFill: number;

  // Paper aesthetic
  paperNoise: boolean;
  sketchyObstacles: boolean;
  bloodAlpha: number;
}

export const NIGHT_THEME: Theme = {
  bg: 0x1a1a2e,
  grid: 0x222244,
  gridAlpha: 0,

  elevationOuter: 0x2e2e48,
  elevationMid: 0x333358,
  elevationInner: 0x3a3a68,
  elevationLabel: '#66ff88',

  obstacleBorder: 0x8888aa,
  obstacleFill: 0x4a4a6e,
  obstacleHighlight: 0x9999bb,

  blue: 0x4a9eff,
  blueZombie: 0x3a7ecc,
  blueDark: 0x2a5a8a,
  red: 0xff4a4a,
  redZombie: 0xcc3333,
  redDark: 0x8a2a2a,

  blueProjectile: 0x88ccff,
  redProjectile: 0xff8888,
  blueImpact: 0x88ccff,
  redImpact: 0xff8888,
  blueKill: '#88ccff',
  redKill: '#ff8888',

  blueBlood: [0x3377dd, 0x2255bb, 0x5599ee],
  redBlood: [0xdd3333, 0xbb2222, 0xee4444],
  blueStain: 0x1a3366,
  redStain: 0x661a1a,

  muzzleFlash: 0xffffaa,
  muzzleCore: 0xffffff,

  barrel: 0xffffff,
  barrelAlpha: 0.6,

  hpBg: 0x333333,
  hpHigh: 0x44ff44,
  hpMid: 0xffaa00,
  hpLow: 0xff4444,

  bluePath: 0x4a9eff,
  redPath: 0xff4a4a,
  bluePathBright: 0x8ac4ff,
  redPathBright: 0xff8a8a,
  labelFill: 0xffffff,
  labelWarn: 0xff4444,
  elevationBonus: 0x66ff88,
  hoverLabelFill: 0xffffff,
  paperNoise: false,
  sketchyObstacles: false,
  bloodAlpha: 1,
};

export const DAY_THEME: Theme = {
  bg: 0xf5f0e0,
  grid: 0xc8bfa0,
  gridAlpha: 0.4,

  elevationOuter: 0xe0d8c0,
  elevationMid: 0xd8d0b8,
  elevationInner: 0xd0c8b0,
  elevationLabel: '#558844',

  obstacleBorder: 0x665544,
  obstacleFill: 0xddd4c0,
  obstacleHighlight: 0xbbaa88,

  blue: 0x2266aa,
  blueZombie: 0x1a5588,
  blueDark: 0x143d66,
  red: 0xaa3333,
  redZombie: 0x882222,
  redDark: 0x661a1a,

  blueProjectile: 0x4488cc,
  redProjectile: 0xcc5555,
  blueImpact: 0x4488cc,
  redImpact: 0xcc5555,
  blueKill: '#336699',
  redKill: '#994444',

  blueBlood: [0x224488, 0x1a3366, 0x3366aa],
  redBlood: [0x883322, 0x662211, 0xaa4433],
  blueStain: 0x1a2d44,
  redStain: 0x44221a,

  muzzleFlash: 0xddcc88,
  muzzleCore: 0xeee8cc,

  barrel: 0x443322,
  barrelAlpha: 0.7,

  hpBg: 0x998877,
  hpHigh: 0x448833,
  hpMid: 0xbb8822,
  hpLow: 0xaa4433,

  bluePath: 0x2266aa,
  redPath: 0xaa3333,
  bluePathBright: 0x4488cc,
  redPathBright: 0xcc5555,
  labelFill: 0x443322,
  labelWarn: 0xaa3333,
  elevationBonus: 0x558844,
  hoverLabelFill: 0x443322,
  paperNoise: true,
  sketchyObstacles: true,
  bloodAlpha: 0.4,
};
