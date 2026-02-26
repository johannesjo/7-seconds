import { Unit, Obstacle, Team, BattleResult, Projectile, TurnPhase, ElevationZone, MissionDef } from './types';
import { ARMY_COMPOSITION, ROUND_DURATION_S, COVER_SCREEN_DURATION_MS, MAP_WIDTH, MAP_HEIGHT, ZONE_DEPTH_RATIO } from './constants';
import { createArmy, createMissionArmy, moveUnit, separateUnits, findTarget, isInRange, hasLineOfSight, tryFireProjectile, updateProjectiles, advanceWaypoint, updateGunAngle, detourWaypoints } from './units';
import { generateObstacles, generateElevationZones } from './battlefield';
import { PathDrawer } from './path-drawer';
import { Renderer } from './renderer';

export type GameEventCallback = (
  event: 'update' | 'end' | 'phase-change',
  data?: BattleResult | { phase: TurnPhase; timeLeft?: number; round?: number },
) => void;

export class GameEngine {
  private units: Unit[] = [];
  private obstacles: Obstacle[] = [];
  private elevationZones: ElevationZone[] = [];
  private projectiles: Projectile[] = [];
  private renderer: Renderer;
  private running = false;
  private speedMultiplier = 1;
  private elapsedTime = 0;
  private roundTimer = 0;
  private onEvent: GameEventCallback;
  private pathDrawer: PathDrawer | null = null;
  private _phase: TurnPhase = 'blue-planning';
  private roundNumber = 1;
  private aiMode = false;
  private mission: MissionDef | null = null;
  private idleTime = 0;
  private blueHoldsZone = false;
  private redHoldsZone = false;
  private zoneControlEnabled = false;
  private oneShotEnabled = false;
  private bloodEnabled = true;
  private endingBattle = false;
  private endDelayTimer = 0;
  private pendingWinner: Team | null = null;
  private pendingWinCondition: 'elimination' | 'zone-control' | null = null;

  constructor(renderer: Renderer, onEvent: GameEventCallback, opts?: { aiMode?: boolean; mission?: MissionDef; zoneControl?: boolean; oneShot?: boolean; blood?: boolean }) {
    this.renderer = renderer;
    this.onEvent = onEvent;
    this.aiMode = opts?.aiMode ?? false;
    this.mission = opts?.mission ?? null;
    this.zoneControlEnabled = opts?.zoneControl ?? false;
    this.oneShotEnabled = opts?.oneShot ?? false;
    this.bloodEnabled = opts?.blood ?? true;
  }

  get phase(): TurnPhase {
    return this._phase;
  }

  startBattle(): void {
    this.renderer.bloodEnabled = this.bloodEnabled;
    if (this.mission) {
      this.units = [
        ...createMissionArmy('blue', this.mission.blueArmy),
        ...createMissionArmy('red', this.mission.redArmy),
      ];
    } else {
      this.units = [...createArmy('blue'), ...createArmy('red')];
    }
    // One-shot mode: set all damage to 9999
    if (this.oneShotEnabled) {
      for (const unit of this.units) {
        unit.damage = 9999;
      }
    }

    this.obstacles = generateObstacles();
    this.elevationZones = generateElevationZones();
    this.projectiles = [];
    this.elapsedTime = 0;
    this.roundTimer = 0;
    this.running = true;

    this.pathDrawer = new PathDrawer(this.renderer.stage, this.renderer.canvas);
    this.pathDrawer.zoneControl = this.zoneControlEnabled;

    // Render initial state — hills under obstacles
    this.renderer.renderElevationZones(this.elevationZones);
    this.renderer.renderObstacles(this.obstacles);
    this.renderer.renderUnits(this.units);

    // Start ticker for rendering during planning
    this.renderer.ticker.add(this.tick, this);

    this.setPhase('blue-planning');
  }

  private coverTimeout: ReturnType<typeof setTimeout> | null = null;

  /** Called by the UI "Done" button to end the current planning phase. */
  confirmPlan(): void {
    if (this._phase === 'blue-planning') {
      this.setPhase('cover');
      // In AI mode, setPhase('cover') already transitions to playing
      if (!this.aiMode) {
        this.coverTimeout = setTimeout(() => {
          this.skipCover();
        }, COVER_SCREEN_DURATION_MS);
      }
    } else if (this._phase === 'red-planning') {
      this.setPhase('playing');
    }
  }

  /** Skip the cover screen early (e.g. on tap). */
  skipCover(): void {
    if (this._phase !== 'cover') return;
    if (this.coverTimeout) {
      clearTimeout(this.coverTimeout);
      this.coverTimeout = null;
    }
    this.setPhase('red-planning');
  }

  private setPhase(phase: TurnPhase): void {
    this._phase = phase;

    if (phase === 'blue-planning') {
      this.pathDrawer?.clearPaths('blue');
      this.pathDrawer?.enable('blue', this.units, this.elevationZones);
    } else if (phase === 'cover') {
      this.pathDrawer?.disable();
      if (this.aiMode) {
        // Skip cover screen, generate AI paths (unless static), go straight to playing
        if (!this.mission?.redStatic) {
          this.generateAiPaths();
        }
        this.onEvent('phase-change', { phase, round: this.roundNumber });
        this.setPhase('playing');
        return;
      }
    } else if (phase === 'red-planning') {
      this.pathDrawer?.clearPaths('red');
      this.pathDrawer?.enable('red', this.units, this.elevationZones);
    } else if (phase === 'playing') {
      this.pathDrawer?.disable();
      this.pathDrawer?.clearGraphics();
      this.roundTimer = ROUND_DURATION_S;
      this.idleTime = 0;
      this.blueHoldsZone = true;
      this.redHoldsZone = true;
      this.renderer.effects?.addRoundStartFlash(MAP_WIDTH, MAP_HEIGHT);
    }

    this.onEvent('phase-change', { phase, round: this.roundNumber });
  }

  /** Generate AI paths for red units: head toward blue side, routing around obstacles. */
  private generateAiPaths(): void {
    const redUnits = this.units.filter(u => u.alive && u.team === 'red');
    for (const unit of redUnits) {
      const margin = 8;
      const padding = unit.radius + margin;
      const rawWaypoints: { x: number; y: number }[] = [];
      const steps = 2 + Math.floor(Math.random() * 2); // 2-3 waypoints
      const targetY = MAP_HEIGHT * 0.85; // Head toward blue spawn side (bottom)
      const stepY = (targetY - unit.pos.y) / steps;

      for (let i = 1; i <= steps; i++) {
        // Try up to 5 times to find a waypoint that doesn't land on an obstacle
        for (let attempt = 0; attempt < 5; attempt++) {
          const spreadX = (Math.random() - 0.5) * MAP_WIDTH * 0.3;
          const wp = {
            x: Math.max(padding, Math.min(MAP_WIDTH - padding, unit.pos.x + spreadX)),
            y: Math.min(MAP_HEIGHT - padding, unit.pos.y + stepY * i),
          };
          const onObstacle = this.obstacles.some(obs => {
            const cx = Math.max(obs.x, Math.min(obs.x + obs.w, wp.x));
            const cy = Math.max(obs.y, Math.min(obs.y + obs.h, wp.y));
            const dx = wp.x - cx;
            const dy = wp.y - cy;
            return dx * dx + dy * dy < padding * padding;
          });
          if (!onObstacle) {
            rawWaypoints.push(wp);
            break;
          }
        }
      }

      // Post-process: insert detour waypoints around obstacles
      const refined: { x: number; y: number }[] = [{ ...unit.pos }];

      for (const wp of rawWaypoints) {
        const last = refined[refined.length - 1];
        const detours = detourWaypoints(last, wp, this.obstacles, padding);
        refined.push(...detours, wp);
      }

      unit.waypoints = refined.slice(1); // remove starting pos
    }
  }

  private tick = (ticker: { deltaMS: number }): void => {
    if (!this.running) return;

    const rawDt = ticker.deltaMS / 1000;
    const dt = this._phase === 'playing' ? rawDt * this.speedMultiplier : rawDt;

    // Always render units (even during planning, need dt for death fade)
    this.renderer.renderUnits(this.units, dt);

    // Animate pulsing indicators during planning
    this.pathDrawer?.updateHover();

    if (this._phase !== 'playing') return;

    // During end delay, only animate effects and dying units (no combat/movement)
    if (this.endingBattle) {
      this.endDelayTimer -= dt;
      this.renderer.effects?.update(dt);
      if (this.endDelayTimer <= 0) {
        this.endBattle(this.pendingWinner!, this.pendingWinCondition!);
      }
      return;
    }

    this.elapsedTime += dt;
    this.roundTimer -= dt;

    // Advance waypoints and move
    for (const unit of this.units) {
      if (!unit.alive) continue;
      advanceWaypoint(unit);
      moveUnit(unit, dt, this.obstacles, this.units);
    }
    separateUnits(this.units, this.obstacles);

    // Combat — auto-target nearest enemy, fire projectiles
    for (const unit of this.units) {
      if (!unit.alive) continue;

      const target = findTarget(unit, this.units, null, this.obstacles);
      const canShoot = target
        && isInRange(unit, target, this.elevationZones)
        && hasLineOfSight(unit.pos, target.pos, this.obstacles);
      if (canShoot) {
        const desired = Math.atan2(target.pos.y - unit.pos.y, target.pos.x - unit.pos.x);
        updateGunAngle(unit, desired, dt);
        const projectile = tryFireProjectile(unit, target, dt, this.elevationZones);
        if (projectile) {
          this.projectiles.push(projectile);
          this.renderer.effects?.addMuzzleFlash(unit.pos, unit.gunAngle, unit.radius);
        }
      } else {
        unit.fireTimer = Math.max(0, unit.fireTimer - dt);
        if (target) {
          // Out of range but enemy exists — face them
          const desired = Math.atan2(target.pos.y - unit.pos.y, target.pos.x - unit.pos.x);
          updateGunAngle(unit, desired, dt);
        } else {
          const speed = Math.sqrt(unit.vel.x * unit.vel.x + unit.vel.y * unit.vel.y);
          if (speed > 1) {
            const desired = Math.atan2(unit.vel.y, unit.vel.x);
            updateGunAngle(unit, desired, dt);
          }
        }
      }
    }

    const { alive: aliveProjectiles, hits } = updateProjectiles(this.projectiles, this.units, dt, this.obstacles);
    this.projectiles = aliveProjectiles;

    // Trigger effects for hits
    const fx = this.renderer.effects;
    for (const hit of hits) {
      const unitGfx = this.renderer.getUnitContainer(hit.targetId);
      if (unitGfx) fx?.addHitFlash(unitGfx);

      if (this.bloodEnabled) {
        const victimTeam: Team = hit.team === 'blue' ? 'red' : 'blue';
        fx?.addBloodSpray(hit.pos, hit.angle, victimTeam, hit.damage);
        if (hit.killed) {
          fx?.addKillText(hit.pos, hit.team);
          fx?.addBloodBurst(hit.pos, hit.angle, victimTeam, hit.damage);
        }
      } else {
        fx?.addImpactBurst(hit.pos, hit.team);
        if (hit.killed) fx?.addKillText(hit.pos, hit.team);
      }
    }

    this.renderer.renderProjectiles(this.projectiles);

    // Update effects
    this.renderer.effects?.update(dt);

    // Zone hold tracking
    if (this.zoneControlEnabled) {
      const zoneDepth = MAP_HEIGHT * ZONE_DEPTH_RATIO;
      const blueInRedZone = this.units.some(u => u.alive && u.team === 'blue' && u.pos.y < zoneDepth);
      const redInRedZone = this.units.some(u => u.alive && u.team === 'red' && u.pos.y < zoneDepth);
      const redInBlueZone = this.units.some(u => u.alive && u.team === 'red' && u.pos.y > MAP_HEIGHT - zoneDepth);
      const blueInBlueZone = this.units.some(u => u.alive && u.team === 'blue' && u.pos.y > MAP_HEIGHT - zoneDepth);

      // Blue holds red zone (top) = blue present AND no red present
      if (!blueInRedZone || redInRedZone) this.blueHoldsZone = false;
      // Red holds blue zone (bottom) = red present AND no blue present
      if (!redInBlueZone || blueInBlueZone) this.redHoldsZone = false;

      this.renderer.renderZoneStatus(this.blueHoldsZone, this.redHoldsZone);
    }

    // HUD update with time left
    this.onEvent('update', { phase: 'playing', timeLeft: Math.max(0, this.roundTimer) });

    // Win condition — elimination
    const blueAlive = this.units.filter(u => u.alive && u.team === 'blue').length;
    const redAlive = this.units.filter(u => u.alive && u.team === 'red').length;

    if (blueAlive === 0 || redAlive === 0) {
      this.endingBattle = true;
      this.endDelayTimer = 0.6;
      this.pendingWinner = blueAlive === 0 ? 'red' : 'blue';
      this.pendingWinCondition = 'elimination';
      return;
    }

    // Check if action is complete — no movement, no combat, no projectiles
    const idle = this.projectiles.length === 0 && this.units.every(u => {
      if (!u.alive) return true;
      // Use actual velocity — moveTarget can be stuck on obstacles
      const speed = u.vel.x * u.vel.x + u.vel.y * u.vel.y;
      if (speed > 1 || u.waypoints.length > 0) return false;
      const target = findTarget(u, this.units, null, this.obstacles);
      return !target || !isInRange(u, target, this.elevationZones);
    });

    // Require sustained idle for 0.5s to avoid transient false positives
    this.idleTime = idle ? this.idleTime + dt : 0;

    // Round over → check zone control win, then back to planning
    if (this.roundTimer <= 0 || this.idleTime >= 0.5) {
      // Zone control win — team held enemy zone for the entire round
      if (this.zoneControlEnabled) {
        if (this.blueHoldsZone) {
          this.endBattle('blue', 'zone-control');
          return;
        }
        if (this.redHoldsZone) {
          this.endBattle('red', 'zone-control');
          return;
        }
      }

      this.projectiles = [];
      this.renderer.renderProjectiles([]);
      this.renderer.renderZoneStatus(false, false);
      this.roundNumber++;
      this.setPhase('blue-planning');
    }
  };

  private endBattle(winner: Team, winCondition: 'elimination' | 'zone-control' = 'elimination'): void {
    this.running = false;
    this.renderer.ticker.remove(this.tick, this);
    this.pathDrawer?.disable();
    this.pathDrawer?.clearGraphics();
    this.renderer.effects?.clear();
    this.renderer.renderZoneStatus(false, false);

    const blueAlive = this.units.filter(u => u.alive && u.team === 'blue').length;
    const redAlive = this.units.filter(u => u.alive && u.team === 'red').length;
    const blueTotal = this.mission
      ? this.mission.blueArmy.reduce((s, c) => s + c.count, 0)
      : ARMY_COMPOSITION.reduce((s, c) => s + c.count, 0);
    const redTotal = this.mission
      ? this.mission.redArmy.reduce((s, c) => s + c.count, 0)
      : ARMY_COMPOSITION.reduce((s, c) => s + c.count, 0);

    this.onEvent('end', {
      winner,
      blueAlive,
      redAlive,
      blueKilled: redTotal - redAlive,
      redKilled: blueTotal - blueAlive,
      duration: this.elapsedTime,
      winCondition,
    });
  }

  setSpeed(multiplier: number): void {
    this.speedMultiplier = multiplier;
  }

  getAliveCount(): { blue: number; red: number } {
    return {
      blue: this.units.filter(u => u.alive && u.team === 'blue').length,
      red: this.units.filter(u => u.alive && u.team === 'red').length,
    };
  }

  stop(): void {
    this.running = false;
    this.renderer.ticker.remove(this.tick, this);
    this.pathDrawer?.destroy();
    this.pathDrawer = null;
    this.renderer.effects?.clear();
  }
}
