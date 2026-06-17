import { Unit, Obstacle, Team, BattleResult, Projectile, TurnPhase, ElevationZone, UnitType, ReplayFrame, ReplayEvent, ReplayData, CtfState, Vec2 } from './types';
import { ROUND_DURATION_S, COVER_SCREEN_DURATION_MS, MAP_WIDTH, MAP_HEIGHT } from './constants';
import { OnlineGameState, MAX_ONLINE_UNITS, MAX_ONLINE_OBSTACLES, MAX_ONLINE_ELEVATION_ZONES } from './online-types';
import { createArmy, generateRandomComposition, createMissionArmy, createCtfArmy, createUnitFromState, moveUnit, separateUnits, findTarget, isInRange, hasLineOfSight, tryFireProjectile, updateProjectiles, advanceWaypoint, updateGunAngle, detourWaypoints, segmentHitsRect, bladeAoeAttack, bomberExplode } from './units';
import { generateObstacles, generateElevationZones, generateCtfObstacles, generateCtfElevationZones } from './battlefield';
import { createCtfState, updateCtfFlags, checkCtfCapture } from './ctf';
import { PathDrawer } from './path-drawer';
import { Renderer } from './renderer';
import { scorePosition, generateCandidates } from './ai-scoring';
import { createRng } from './rng';

const FIXED_DT = 1 / 60;

type GameEventCallback = (
  event: 'update' | 'end' | 'phase-change' | 'wave-clear',
  data?: BattleResult | { phase: TurnPhase; timeLeft?: number; round?: number },
) => void;

export class GameEngine {
  private units: Unit[] = [];
  private obstacles: Obstacle[] = [];
  private elevationZones: ElevationZone[] = [];
  private projectiles: Projectile[] = [];
  private renderer: Renderer | null;
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
  private endingBattle = false;
  private endDelayTimer = 0;
  private pendingWinner: Team | null = null;
  private hordeMode = false;
  private hordeStartDelay = 0;
  private hordeBlueUnits: Unit[] | null = null;
  private hordeRedArmy: { type: UnitType; count: number }[] | null = null;
  private hordeMap: { obstacles: Obstacle[]; elevationZones: ElevationZone[] } | null = null;
  private ctfMode = false;
  private ctfState: CtfState | null = null;
  private replayFrames: ReplayFrame[] = [];
  private replayEvents: ReplayEvent[] = [];
  private onlineHostMode = false;
  private onPhaseChangeCallback?: (phase: TurnPhase) => void;
  private accumulator = 0;
  private simulationTick = 0;
  private rng: () => number = Math.random;
  private seed = 0;
  private lockstepMode = false;

  constructor(renderer: Renderer | null, onEvent: GameEventCallback, opts?: {
    aiMode?: boolean;
    horde?: boolean;
    hordeBlueUnits?: Unit[];
    hordeRedArmy?: { type: UnitType; count: number }[];
    hordeMap?: { obstacles: Obstacle[]; elevationZones: ElevationZone[] };
    ctfMode?: boolean;
    ctfHotseat?: boolean;
    onlineHost?: boolean;
    onPhaseChange?: (phase: TurnPhase) => void;
    seed?: number;
  }) {
    this.renderer = renderer;
    this.onEvent = onEvent;
    this.aiMode = opts?.aiMode ?? false;
    this.seed = opts?.seed ?? (Math.random() * 0x7fffffff) | 0;
    this.hordeMode = opts?.horde ?? false;
    this.hordeBlueUnits = opts?.hordeBlueUnits ?? null;
    this.hordeRedArmy = opts?.hordeRedArmy ?? null;
    this.hordeMap = opts?.hordeMap ?? null;
    this.ctfMode = opts?.ctfMode ?? false;
    this.onlineHostMode = opts?.onlineHost ?? false;

    this.onPhaseChangeCallback = opts?.onPhaseChange;
  }

  get phase(): TurnPhase {
    return this._phase;
  }

  getSeed(): number {
    return this.seed;
  }

  /** The effective PRNG seed for the current round (base seed + round number).
   *  This is the exact value passed to createRng() when a round starts, so it's
   *  what the host must transmit to the guest for lockstep determinism. */
  getRoundSeed(): number {
    return this.seed + this.roundNumber;
  }

  startBattle(): void {

    // Load map before spawning units so we can avoid placing them inside blocks
    if (this.ctfMode) {
      this.obstacles = generateCtfObstacles();
      this.elevationZones = generateCtfElevationZones();
      this.units = [...createCtfArmy('blue', this.obstacles), ...createCtfArmy('red', this.obstacles)];
      this.ctfState = createCtfState();
    } else if (this.hordeMap) {
      this.obstacles = this.hordeMap.obstacles;
      this.elevationZones = this.hordeMap.elevationZones;
    } else {
      this.obstacles = generateObstacles();
      this.elevationZones = generateElevationZones();
    }

    const allBlocks = this.obstacles;

    if (!this.ctfMode) {
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
        const composition = generateRandomComposition();
        this.units = [...createArmy('blue', composition), ...createArmy('red', composition)];
      }
    }
    this.projectiles = [];
    this.elapsedTime = 0;
    this.roundTimer = 0;
    this.running = true;

    if (this.renderer) {
      this.pathDrawer = new PathDrawer(this.renderer.stage, this.renderer.canvas, (pos) => this.renderer!.highlightZonesAt(pos));
      this.pathDrawer.theme = this.renderer.currentTheme;

      // Render initial state — hills under obstacles
      this.renderer.renderElevationZones(this.elevationZones);
      this.renderer.renderObstacles(this.obstacles);
      if (this.ctfMode) {
        this.renderer.renderBaseZones();
      }
      this.renderer.renderUnits(this.units);

      // Start ticker for rendering during planning
      this.renderer.ticker.add(this.tick, this);
    }

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
      if (this.onlineHostMode) {
        // Online host: skip cover, go to red-planning without local path drawing
        this.onEvent('phase-change', { phase, round: this.roundNumber });
        this.setPhase('red-planning');
        return;
      }
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
      if (!this.onlineHostMode) {
        this.pathDrawer?.clearPaths('red');
        this.pathDrawer?.enable('red', this.units, this.elevationZones);
      }
      // When onlineHostMode, we wait for external setRedPaths() + confirmPlan()
    } else if (phase === 'playing') {
      this.pathDrawer?.disable();
      this.pathDrawer?.clearGraphics();
      this.roundTimer = ROUND_DURATION_S;
      this.idleTime = 0;
      this.accumulator = 0;
      this.simulationTick = 0;
      this.rng = createRng(this.seed + this.roundNumber);
      this.renderer?.effects?.addRoundStartFlash(MAP_WIDTH, MAP_HEIGHT);
    }

    this.onEvent('phase-change', { phase, round: this.roundNumber });
    this.onPhaseChangeCallback?.(phase);
  }

  /** Generate AI paths for red units using position-scoring system. */
  private generateAiPaths(): void {
    const allBlockers = this.obstacles;
    const redUnits = this.units.filter(u => u.alive && u.team === 'red');
    const enemies = this.units.filter(u => u.alive && u.team === 'blue');

    if (redUnits.length === 0) return;

    const candidates = generateCandidates(
      redUnits[0],
      this.obstacles,
      this.elevationZones,
    );

    for (const unit of redUnits) {
      // Zombies, shielders, and bombers don't use AI planning — they chase in real-time
      if (unit.type === 'zombie' || unit.type === 'shielder' || unit.type === 'bomber') continue;
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
          elevationZones: this.elevationZones,
          ctfState: this.ctfState ?? undefined,
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

    // Always render units (even during planning, need rawDt for death fade)
    this.renderer?.renderUnits(this.units, rawDt, this.ctfState ?? undefined, this._phase === 'playing');

    if (this.ctfState) {
      this.renderer?.renderFlags(this.ctfState);
    }

    // Animate pulsing indicators during planning
    this.pathDrawer?.updateHover();

    if (this._phase !== 'playing') return;

    // During end delay, only animate effects and dying units (no combat/movement)
    if (this.endingBattle) {
      this.endDelayTimer -= rawDt;
      this.renderer?.effects?.update(rawDt);
      if (this.endDelayTimer <= 0) {
        this.endBattle(this.pendingWinner!);
      }
      return;
    }

    // Fixed timestep accumulator: simulation runs at exactly FIXED_DT
    this.accumulator += rawDt * this.speedMultiplier;
    while (this.accumulator >= FIXED_DT) {
      this.simulationStep(FIXED_DT);
      this.accumulator -= FIXED_DT;
    }

    // Render at display rate (after all simulation steps)
    this.renderer?.renderProjectiles(this.projectiles);
    this.renderer?.effects?.update(rawDt);
    this.onEvent('update', { phase: 'playing', timeLeft: Math.max(0, this.roundTimer) });
  };

  /** Run one fixed-timestep simulation step. */
  private simulationStep(dt: number): void {
    this.elapsedTime += dt;
    this.roundTimer -= dt;
    this.simulationTick++;

    const redDelayed = this.updateHordeDelay(dt);
    // Chase AI drives the AI opponent's red units. Skip it when red is human-
    // controlled (online guest, local/CTF hotseat) — otherwise their drawn paths
    // get overwritten and units appear to move on their own.
    if (this.aiMode) this.updateChaseAI();
    this.updateMovement(dt, redDelayed);
    this.updateCombat(dt);
    const hits = this.updateProjectiles(dt);
    this.dispatchHitEffects(hits);
    this.handleBomberChainExplosions(hits);

    // Record replay frame after all state updates
    this.recordFrame();

    if (this.checkCtfCapture()) return;
    if (this.checkElimination()) return;
    this.checkRoundEnd(dt);
  }

  /** Horde start delay -- skip red movement for 2s so player can react. */
  private updateHordeDelay(dt: number): boolean {
    const redDelayed = this.hordeStartDelay > 0;
    if (redDelayed) this.hordeStartDelay -= dt;
    return redDelayed;
  }

  /** AI-mode only: zombies, shielders, and bombers on the red team chase the
   *  closest enemy. Gated by aiMode at the call site — never overrides the paths
   *  of a human-controlled red team. */
  private updateChaseAI(): void {
    for (const unit of this.units) {
      if (!unit.alive || unit.team !== 'red' || (unit.type !== 'zombie' && unit.type !== 'shielder' && unit.type !== 'bomber')) continue;
      const target = findTarget(unit, this.units, null, this.obstacles);
      if (target) {
        unit.waypoints = [];
        unit.moveTarget = { x: target.pos.x, y: target.pos.y };
      }
    }
  }

  /** Advance waypoints and move all living units. */
  private updateMovement(dt: number, redDelayed: boolean): void {
    for (const unit of this.units) {
      if (!unit.alive) continue;
      if (redDelayed && unit.team === 'red') continue;
      advanceWaypoint(unit, dt);
      moveUnit(unit, dt, this.obstacles, this.units, this.rng);
    }
    separateUnits(this.units, this.obstacles);
  }

  /** Auto-target nearest enemy, fire projectiles, handle melee blades. */
  private updateCombat(dt: number): void {
    for (const unit of this.units) {
      if (!unit.alive) continue;

      const target = findTarget(unit, this.units, null, this.obstacles);

      // Blade uses AoE melee attack instead of projectiles
      if (unit.type === 'blade') {
        if (target) {
          const desired = Math.atan2(target.pos.y - unit.pos.y, target.pos.x - unit.pos.x);
          updateGunAngle(unit, desired, dt);
        }
        const aoeHits = bladeAoeAttack(unit, this.units, dt);
        for (const hit of aoeHits) {
          this.replayEvents.push({
            frame: this.replayFrames.length,
            type: hit.killed ? 'kill' : 'hit',
            pos: hit.pos,
            angle: unit.gunAngle,
            damage: hit.damage,
            flanked: false,
            team: hit.team,
            targetId: hit.targetId,
          });
        }
        continue;
      }

      const canShoot = target
        && isInRange(unit, target, this.elevationZones)
        && hasLineOfSight(unit.pos, target.pos, this.obstacles, unit.projectileRadius);
      if (canShoot) {
        const desired = Math.atan2(target.pos.y - unit.pos.y, target.pos.x - unit.pos.x);
        updateGunAngle(unit, desired, dt);
        const projectiles = tryFireProjectile(unit, target, dt, this.elevationZones);
        if (projectiles.length > 0) {
          this.projectiles.push(...projectiles);
          this.renderer?.effects?.addMuzzleFlash(unit.pos, unit.gunAngle, unit.radius);
          this.replayEvents.push({
            frame: this.replayFrames.length,
            type: 'fire',
            pos: { x: unit.pos.x, y: unit.pos.y },
            angle: unit.gunAngle,
            damage: projectiles[0].damage,
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
  }

  /** Update projectile positions and resolve collisions. Returns hit results. */
  private updateProjectiles(dt: number): ReturnType<typeof updateProjectiles>['hits'] {
    const { alive: aliveProjectiles, hits } = updateProjectiles(this.projectiles, this.units, dt, this.obstacles);
    this.projectiles = aliveProjectiles;
    return hits;
  }

  /** Trigger visual effects for projectile hits and record replay events. */
  private dispatchHitEffects(hits: ReturnType<typeof updateProjectiles>['hits']): void {
    const fx = this.renderer?.effects ?? null;
    for (const hit of hits) {
      const unitGfx = this.renderer?.getUnitContainer(hit.targetId);
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

      const victimTeam: Team = hit.team === 'blue' ? 'red' : 'blue';
      const effectDamage = hit.flanked ? hit.damage * 1.5 : hit.damage;
      fx?.addBloodSpray(hit.pos, hit.angle, victimTeam, effectDamage);
      if (hit.killed) {
        fx?.addKillText(hit.pos, hit.team);
        fx?.addBloodBurst(hit.pos, hit.angle, victimTeam, effectDamage);
      }
    }
  }

  /** Handle bomber chain explosions when bombers are killed. */
  private handleBomberChainExplosions(hits: ReturnType<typeof updateProjectiles>['hits']): void {
    const fx = this.renderer?.effects ?? null;
    for (const hit of hits) {
      if (hit.killed) {
        const deadUnit = this.units.find(u => u.id === hit.targetId);
        if (deadUnit && deadUnit.type === 'bomber') {
          fx?.addExplosion(deadUnit.pos, 80);
          const explosionHits = bomberExplode(deadUnit, this.units);
          for (const eh of explosionHits) {
            this.replayEvents.push({
              frame: this.replayFrames.length,
              type: eh.killed ? 'kill' : 'hit',
              pos: eh.pos,
              angle: 0,
              damage: eh.damage,
              flanked: false,
              team: deadUnit.team,
              targetId: eh.targetId,
            });
            // Chain reaction: another bomber was killed by this explosion
            if (eh.killed) {
              const chainDead = this.units.find(u => u.id === eh.targetId);
              if (chainDead?.type === 'bomber') {
                fx?.addExplosion(chainDead.pos, 80);
              }
            }
          }
        }
      }
    }
  }

  /** Check CTF capture win condition. Returns true if the round ended. */
  private checkCtfCapture(): boolean {
    if (!this.ctfMode || !this.ctfState) return false;
    updateCtfFlags(this.ctfState, this.units);
    const capturer = checkCtfCapture(this.ctfState);
    if (capturer) {
      this.ctfState.winner = capturer;
      this.endingBattle = true;
      this.endDelayTimer = 0.6;
      this.pendingWinner = capturer;
      this.projectiles = [];
      this.renderer?.renderProjectiles([]);
      return true;
    }
    return false;
  }

  /** Check elimination win condition. Returns true if the round ended. */
  private checkElimination(): boolean {
    const blueAlive = this.units.filter(u => u.alive && u.team === 'blue').length;
    const redAlive = this.units.filter(u => u.alive && u.team === 'red').length;

    if (blueAlive === 0 || redAlive === 0) {
      if (redAlive === 0 && this.hordeMode) {
        // Wave cleared — don't end the battle, emit wave-clear event
        this.running = false;
        this.renderer?.ticker.remove(this.tick, this);
        this.projectiles = [];
        this.renderer?.renderProjectiles([]);
        this.pathDrawer?.disable();
        this.pathDrawer?.clearGraphics();
        this.onEvent('wave-clear');
        return true;
      }
      this.endingBattle = true;
      this.endDelayTimer = 0.6;
      this.pendingWinner = blueAlive === 0 ? 'red' : 'blue';
      this.projectiles = [];
      this.renderer?.renderProjectiles([]);
      return true;
    }
    return false;
  }

  /** Check if action is complete and transition back to planning phase.
   *  Skipped in lockstep mode — host is authoritative for round transitions. */
  private checkRoundEnd(dt: number): void {
    if (this.lockstepMode) return;
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

    // Round over → back to planning
    if (this.roundTimer <= 0 || this.idleTime >= 0.5) {
      this.projectiles = [];
      this.renderer?.renderProjectiles([]);
      this.roundNumber++;
      this.setPhase('blue-planning');
    }
  };

  private recordFrame(): void {
    const frame: ReplayFrame = {
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
    };

    if (this.ctfState) {
      frame.blueFlag = {
        x: this.ctfState.blueFlag.pos.x,
        y: this.ctfState.blueFlag.pos.y,
        homeX: this.ctfState.blueFlag.homePos.x,
        homeY: this.ctfState.blueFlag.homePos.y,
        carrierId: this.ctfState.blueFlag.carrierId,
        dropped: this.ctfState.blueFlag.dropped,
      };
      frame.redFlag = {
        x: this.ctfState.redFlag.pos.x,
        y: this.ctfState.redFlag.pos.y,
        homeX: this.ctfState.redFlag.homePos.x,
        homeY: this.ctfState.redFlag.homePos.y,
        carrierId: this.ctfState.redFlag.carrierId,
        dropped: this.ctfState.redFlag.dropped,
      };
    }

    this.replayFrames.push(frame);
  }

  getReplayData(): ReplayData | null {
    if (this.replayFrames.length === 0) return null;
    return {
      frames: this.replayFrames,
      events: this.replayEvents,
      obstacles: this.obstacles,
      elevationZones: this.elevationZones,
      ctfMode: this.ctfMode || undefined,
    };
  }

  private endBattle(winner: Team): void {
    this.running = false;
    this.renderer?.ticker.remove(this.tick, this);
    this.projectiles = [];
    this.renderer?.renderProjectiles([]);
    this.pathDrawer?.disable();
    this.pathDrawer?.clearGraphics();
    this.renderer?.effects?.clear();

    const blueAlive = this.units.filter(u => u.alive && u.team === 'blue').length;
    const redAlive = this.units.filter(u => u.alive && u.team === 'red').length;
    const blueTotal = this.units.filter(u => u.team === 'blue').length;
    const redTotal = this.units.filter(u => u.team === 'red').length;

    this.onEvent('end', {
      winner,
      blueAlive,
      redAlive,
      blueKilled: redTotal - redAlive,
      redKilled: blueTotal - blueAlive,
      duration: this.elapsedTime,
    });
  }

  /** Start simulation directly in 'playing' state (for guest lockstep).
   *  Bypasses planning phases — call after loadOnlineGameState + setPaths.
   *  Pass the host's per-round seed (from OnlineWaypointData) so the guest's
   *  PRNG matches the host exactly; the guest can't derive it locally because
   *  its headless engine doesn't track the round number. */
  startPlaying(roundSeed?: number): void {
    this.running = true;
    this.lockstepMode = true;
    this._phase = 'playing';
    this.roundTimer = ROUND_DURATION_S;
    this.idleTime = 0;
    this.accumulator = 0;
    this.simulationTick = 0;
    this.endingBattle = false;
    this.pendingWinner = null;
    this.rng = createRng(roundSeed ?? (this.seed + this.roundNumber));
    this.replayFrames = [];
    this.replayEvents = [];
  }

  /** Drive the engine externally (for headless mode). Pass real deltaMS. */
  externalTick(deltaMS: number): void {
    this.tick({ deltaMS });
  }

  getSimulationTick(): number {
    return this.simulationTick;
  }

  /** Get replay events starting from the given index (for dispatching effects). */
  getReplayEventsSince(startIndex: number): { events: ReplayEvent[]; nextIndex: number } {
    const events = this.replayEvents.slice(startIndex);
    return { events, nextIndex: this.replayEvents.length };
  }

  /** Set waypoints for a team's units. Validates and caps input from remote peer. */
  private setPaths(team: Team, paths: { unitId: string; waypoints: Vec2[] }[]): void {
    const maxWaypoints = 100;
    for (const p of paths) {
      if (!Array.isArray(p.waypoints)) continue;
      const unit = this.units.find(u => u.id === p.unitId);
      if (unit && unit.team === team) {
        const valid = p.waypoints.slice(0, maxWaypoints).filter(
          w => typeof w.x === 'number' && typeof w.y === 'number'
            && Number.isFinite(w.x) && Number.isFinite(w.y),
        );
        unit.waypoints = valid;
      }
    }
  }

  setBluePaths(paths: { unitId: string; waypoints: Vec2[] }[]): void {
    this.setPaths('blue', paths);
  }

  /** Load full game state from an OnlineGameState snapshot (for guest sync).
   *  Caps array sizes defensively — the snapshot comes from an untrusted peer. */
  loadOnlineGameState(state: OnlineGameState): void {
    this.obstacles = state.obstacles.slice(0, MAX_ONLINE_OBSTACLES);
    this.elevationZones = state.elevationZones.slice(0, MAX_ONLINE_ELEVATION_ZONES);
    this.units = state.units.slice(0, MAX_ONLINE_UNITS).map(u => createUnitFromState(u));
    this.projectiles = [];
    this.replayFrames = [];
    this.replayEvents = [];
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

  getCtfState(): CtfState | null {
    return this.ctfState;
  }

  getUnits(): Unit[] {
    return this.units;
  }

  getProjectiles(): Projectile[] {
    return this.projectiles;
  }

  getMapData(): { obstacles: Obstacle[]; elevationZones: ElevationZone[] } {
    return { obstacles: this.obstacles, elevationZones: this.elevationZones };
  }

  setRedPaths(paths: { unitId: string; waypoints: Vec2[] }[]): void {
    this.setPaths('red', paths);
  }

  getOnlineGameState(): OnlineGameState {
    return {
      units: this.units.map(u => ({
        id: u.id, type: u.type, team: u.team,
        x: u.pos.x, y: u.pos.y,
        hp: u.hp, maxHp: u.maxHp, radius: u.radius,
        speed: u.speed, range: u.range, gunAngle: u.gunAngle,
      })),
      obstacles: this.obstacles,
      elevationZones: this.elevationZones,
      mapWidth: MAP_WIDTH, mapHeight: MAP_HEIGHT,
    };
  }

  /** Generate a fresh standard PvP starting state (army + map) headlessly, for
   *  seeding an async match's authoritative initial state at creation time. */
  static generateInitialState(): OnlineGameState {
    const engine = new GameEngine(null, () => {});
    engine.startBattle();
    const state = engine.getOnlineGameState();
    engine.stop();
    return state;
  }

  /** Deterministically resolve one async round to its authoritative end state.
   *  Runs the fixed-timestep simulation in a tight loop — stopping when a side
   *  is eliminated or `maxTicks` is reached — so the result is independent of
   *  frame pacing and identical on every client. The animated playback shown to
   *  the player is purely cosmetic; THIS is what gets persisted. */
  static resolveRound(
    startState: OnlineGameState,
    bluePaths: { unitId: string; waypoints: Vec2[] }[],
    redPaths: { unitId: string; waypoints: Vec2[] }[],
    seed: number,
    maxTicks: number,
  ): { endState: OnlineGameState; gameOver: boolean } {
    const e = new GameEngine(null, () => {}, { seed });
    e.loadOnlineGameState(startState);
    e.setBluePaths(bluePaths);
    e.setRedPaths(redPaths);
    e.startPlaying();
    // Runs the full maxTicks unless a side is eliminated — deliberately ignoring
    // the live engine's idle-early-end, so the cutoff is a pure, deterministic
    // function of tick count (identical on every client). Async rounds therefore
    // always play the full duration; live rounds may end early when combat idles.
    while (e.simulationTick < maxTicks) {
      e.simulationStep(FIXED_DT);
      const blueAlive = e.units.some(u => u.alive && u.team === 'blue');
      const redAlive = e.units.some(u => u.alive && u.team === 'red');
      if (!blueAlive || !redAlive) break;
    }
    const blueAlive = e.units.some(u => u.alive && u.team === 'blue');
    const redAlive = e.units.some(u => u.alive && u.team === 'red');
    return { endState: e.getOnlineGameState(), gameOver: !blueAlive || !redAlive };
  }

  stop(): void {
    this.running = false;
    this.renderer?.ticker.remove(this.tick, this);
    this.pathDrawer?.destroy();
    this.pathDrawer = null;
    this.renderer?.effects?.clear();
    this.renderer?.clearCtfGraphics();
  }
}
