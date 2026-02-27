import { Unit, Obstacle, Team, BattleResult, Projectile, TurnPhase, ElevationZone, CoverBlock, UnitType, ReplayFrame, ReplayEvent, ReplayData } from './types';
import { ARMY_COMPOSITION, ROUND_DURATION_S, COVER_SCREEN_DURATION_MS, MAP_WIDTH, MAP_HEIGHT, ZONE_DEPTH_RATIO } from './constants';
import { createArmy, createMissionArmy, moveUnit, separateUnits, findTarget, isInRange, hasLineOfSight, tryFireProjectile, updateProjectiles, advanceWaypoint, updateGunAngle, detourWaypoints, segmentHitsRect } from './units';
import { generateObstacles, generateElevationZones, generateCoverBlocks } from './battlefield';
import { PathDrawer } from './path-drawer';
import { Renderer } from './renderer';
import { scorePosition, generateCandidates } from './ai-scoring';

export type GameEventCallback = (
  event: 'update' | 'end' | 'phase-change' | 'wave-clear',
  data?: BattleResult | { phase: TurnPhase; timeLeft?: number; round?: number },
) => void;

export class GameEngine {
  private units: Unit[] = [];
  private obstacles: Obstacle[] = [];
  private elevationZones: ElevationZone[] = [];
  private coverBlocks: CoverBlock[] = [];
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
  private hordeMode = false;
  private hordeStartDelay = 0;
  private hordeBlueUnits: Unit[] | null = null;
  private hordeRedArmy: { type: UnitType; count: number }[] | null = null;
  private hordeMap: { obstacles: Obstacle[]; elevationZones: ElevationZone[]; coverBlocks: CoverBlock[] } | null = null;
  private replayFrames: ReplayFrame[] = [];
  private replayEvents: ReplayEvent[] = [];

  constructor(renderer: Renderer, onEvent: GameEventCallback, opts?: {
    aiMode?: boolean;
    zoneControl?: boolean;
    oneShot?: boolean;
    blood?: boolean;
    horde?: boolean;
    hordeBlueUnits?: Unit[];
    hordeRedArmy?: { type: UnitType; count: number }[];
    hordeMap?: { obstacles: Obstacle[]; elevationZones: ElevationZone[]; coverBlocks: CoverBlock[] };
  }) {
    this.renderer = renderer;
    this.onEvent = onEvent;
    this.aiMode = opts?.aiMode ?? false;
    this.zoneControlEnabled = opts?.zoneControl ?? false;
    this.oneShotEnabled = opts?.oneShot ?? false;
    this.bloodEnabled = opts?.blood ?? true;
    this.hordeMode = opts?.horde ?? false;
    this.hordeBlueUnits = opts?.hordeBlueUnits ?? null;
    this.hordeRedArmy = opts?.hordeRedArmy ?? null;
    this.hordeMap = opts?.hordeMap ?? null;
  }

  get phase(): TurnPhase {
    return this._phase;
  }

  startBattle(): void {
    this.renderer.bloodEnabled = this.bloodEnabled;

    // Load map before spawning units so we can avoid placing them inside blocks
    if (this.hordeMap) {
      this.obstacles = this.hordeMap.obstacles;
      this.elevationZones = this.hordeMap.elevationZones;
      this.coverBlocks = this.hordeMap.coverBlocks;
    } else {
      this.obstacles = generateObstacles();
      this.elevationZones = generateElevationZones();
      this.coverBlocks = generateCoverBlocks(this.obstacles);
    }

    const allBlocks = [...this.obstacles, ...this.coverBlocks];

    if (this.hordeMode && this.hordeBlueUnits && this.hordeRedArmy) {
      // Horde mode: use pre-created blue units + spawn wave enemies
      const redUnits = createMissionArmy('red', this.hordeRedArmy, allBlocks);
      // Prefix red IDs with wave index to avoid renderer collisions
      const waveTag = `w${Date.now() % 10000}`;
      for (const u of redUnits) {
        u.id = u.id.replace('red_', `red_${waveTag}_`);
      }
      this.units = [...this.hordeBlueUnits, ...redUnits];
    } else {
      this.units = [...createArmy('blue'), ...createArmy('red')];
    }
    // One-shot mode: set all damage to 9999
    if (this.oneShotEnabled) {
      for (const unit of this.units) {
        unit.damage = 9999;
      }
    }
    this.projectiles = [];
    this.elapsedTime = 0;
    this.roundTimer = 0;
    this.running = true;

    this.pathDrawer = new PathDrawer(this.renderer.stage, this.renderer.canvas);
    this.pathDrawer.zoneControl = this.zoneControlEnabled;

    // Render initial state — hills under obstacles
    this.renderer.renderElevationZones(this.elevationZones);
    this.renderer.renderObstacles(this.obstacles);
    this.renderer.renderCoverBlocks(this.coverBlocks);
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
      if (this.hordeMode) this.generateAiPaths();
      this.pathDrawer?.enable('blue', this.units, this.elevationZones);
    } else if (phase === 'cover') {
      this.pathDrawer?.disable();
      if (this.aiMode) {
        // Skip cover screen, generate AI paths, go straight to playing
        if (!this.hordeMode) {
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
      if (this.hordeMode && this.roundNumber === 1) this.hordeStartDelay = 1;
    }

    this.onEvent('phase-change', { phase, round: this.roundNumber });
  }

  /** Generate AI paths for red units using position-scoring system. */
  private generateAiPaths(): void {
    const allBlockers = [...this.obstacles, ...this.coverBlocks];
    const redUnits = this.units.filter(u => u.alive && u.team === 'red');
    const enemies = this.units.filter(u => u.alive && u.team === 'blue');

    const candidates = generateCandidates(
      redUnits[0] ?? { pos: { x: MAP_WIDTH / 2, y: MAP_HEIGHT / 2 }, speed: 120, radius: 10 } as Unit,
      this.obstacles,
      this.coverBlocks,
      this.elevationZones,
    );

    for (const unit of redUnits) {
      const margin = 8;
      const padding = unit.radius + margin;

      // Score each candidate, then verify the full path is navigable
      const scored: { pos: typeof unit.pos; score: number }[] = [];
      for (const candidate of candidates) {
        const s = scorePosition({
          candidate,
          unit,
          enemies,
          obstacles: this.obstacles,
          coverBlocks: this.coverBlocks,
          elevationZones: this.elevationZones,
        });
        scored.push({ pos: candidate, score: s });
      }
      scored.sort((a, b) => b.score - a.score);

      // Pick the best candidate whose full waypoint chain is obstacle-free
      let bestPos = unit.pos;
      let bestWaypoints: typeof unit.waypoints = [];
      for (const { pos: candidate, score } of scored) {
        if (score === -Infinity) break;
        const detours = detourWaypoints(unit.pos, candidate, allBlockers, padding);
        const chain = [...detours, candidate];

        // Validate every segment in the chain
        let pathClear = true;
        let prev = unit.pos;
        for (const wp of chain) {
          if (allBlockers.some(o => segmentHitsRect(prev, wp, o, padding))) {
            pathClear = false;
            break;
          }
          prev = wp;
        }

        if (pathClear) {
          bestPos = candidate;
          bestWaypoints = chain;
          break;
        }
      }

      unit.waypoints = bestWaypoints.length > 0 ? bestWaypoints : [bestPos];
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

    // Horde start delay — skip red movement for 2s so player can react
    const redDelayed = this.hordeStartDelay > 0;
    if (redDelayed) this.hordeStartDelay -= dt;

    // Advance waypoints and move
    for (const unit of this.units) {
      if (!unit.alive) continue;
      if (redDelayed && unit.team === 'red') continue;
      advanceWaypoint(unit);
      moveUnit(unit, dt, [...this.obstacles, ...this.coverBlocks], this.units);
    }
    separateUnits(this.units, [...this.obstacles, ...this.coverBlocks]);

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
          this.replayEvents.push({
            frame: this.replayFrames.length,
            type: 'fire',
            pos: { x: unit.pos.x, y: unit.pos.y },
            angle: unit.gunAngle,
            damage: projectile.damage,
            flanked: false,
            team: unit.team,
          });
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

    const { alive: aliveProjectiles, hits } = updateProjectiles(this.projectiles, this.units, dt, this.obstacles, this.coverBlocks);
    this.projectiles = aliveProjectiles;

    // Trigger effects for hits + record replay events
    const fx = this.renderer.effects;
    for (const hit of hits) {
      const unitGfx = this.renderer.getUnitContainer(hit.targetId);
      if (unitGfx) fx?.addHitFlash(unitGfx);

      this.replayEvents.push({
        frame: this.replayFrames.length,
        type: hit.killed ? 'kill' : 'hit',
        pos: { ...hit.pos },
        angle: hit.angle,
        damage: hit.damage,
        flanked: hit.flanked,
        team: hit.team,
        targetId: hit.targetId,
      });

      if (this.bloodEnabled) {
        const victimTeam: Team = hit.team === 'blue' ? 'red' : 'blue';
        const effectDamage = hit.flanked ? hit.damage * 1.5 : hit.damage;
        fx?.addBloodSpray(hit.pos, hit.angle, victimTeam, effectDamage);
        if (hit.killed) {
          fx?.addKillText(hit.pos, hit.team);
          fx?.addBloodBurst(hit.pos, hit.angle, victimTeam, effectDamage);
        }
      } else {
        fx?.addImpactBurst(hit.pos, hit.team);
        if (hit.killed) fx?.addKillText(hit.pos, hit.team);
      }
    }

    // Record replay frame after all state updates
    this.recordFrame();

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
      if (redAlive === 0 && this.hordeMode) {
        // Wave cleared — don't end the battle, emit wave-clear event
        this.running = false;
        this.renderer.ticker.remove(this.tick, this);
        this.pathDrawer?.disable();
        this.pathDrawer?.clearGraphics();
        this.onEvent('wave-clear');
        return;
      }
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

  private recordFrame(): void {
    this.replayFrames.push({
      units: this.units.map(u => ({
        id: u.id,
        type: u.type,
        team: u.team,
        x: u.pos.x,
        y: u.pos.y,
        vx: u.vel.x,
        vy: u.vel.y,
        gunAngle: u.gunAngle,
        hp: u.hp,
        maxHp: u.maxHp,
        alive: u.alive,
        radius: u.radius,
      })),
      projectiles: this.projectiles.map(p => ({
        x: p.pos.x,
        y: p.pos.y,
        vx: p.vel.x,
        vy: p.vel.y,
        damage: p.damage,
        radius: p.radius,
        team: p.team,
        maxRange: p.maxRange,
        distanceTraveled: p.distanceTraveled,
        trail: p.trail ? p.trail.map(t => ({ ...t })) : undefined,
      })),
    });
  }

  getReplayData(): ReplayData | null {
    if (this.replayFrames.length === 0) return null;
    return {
      frames: this.replayFrames,
      events: this.replayEvents,
      obstacles: this.obstacles,
      elevationZones: this.elevationZones,
      coverBlocks: this.coverBlocks,
    };
  }

  private endBattle(winner: Team, winCondition: 'elimination' | 'zone-control' = 'elimination'): void {
    this.running = false;
    this.renderer.ticker.remove(this.tick, this);
    this.pathDrawer?.disable();
    this.pathDrawer?.clearGraphics();
    this.renderer.effects?.clear();
    this.renderer.renderZoneStatus(false, false);

    const blueAlive = this.units.filter(u => u.alive && u.team === 'blue').length;
    const redAlive = this.units.filter(u => u.alive && u.team === 'red').length;
    const blueTotal = ARMY_COMPOSITION.reduce((s, c) => s + c.count, 0);
    const redTotal = ARMY_COMPOSITION.reduce((s, c) => s + c.count, 0);

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

  getUnits(): Unit[] {
    return this.units;
  }

  getMapData(): { obstacles: Obstacle[]; elevationZones: ElevationZone[]; coverBlocks: CoverBlock[] } {
    return { obstacles: this.obstacles, elevationZones: this.elevationZones, coverBlocks: this.coverBlocks };
  }

  stop(): void {
    this.running = false;
    this.renderer.ticker.remove(this.tick, this);
    this.pathDrawer?.destroy();
    this.pathDrawer = null;
    this.renderer.effects?.clear();
  }
}
