import {
  ATTACK_RANGE,
  MAX_MONSTER_PATHFINDS_PER_TICK,
  MONSTER_AGGRO_RADIUS,
  MONSTER_ATTACK_DAMAGE,
  MONSTER_ATTACK_INTERVAL_MS,
  MONSTER_CORPSE_MS,
  MONSTER_LEASH_RADIUS,
  MONSTER_LOSE_RADIUS,
  MONSTER_RESPAWN_MS,
  MONSTER_SPEED,
  MONSTER_STOP_DISTANCE,
  MONSTER_THINK_MS,
  setPath,
  stepMover,
  TICK_MS,
  TICK_RATE,
} from '@mmo/shared';
import type { Pathfinder } from '@mmo/shared';
import type { Entity, Monster, Player } from './entity';

/** 同一只怪物两次追击寻路的最小间隔。 */
const REPATH_MS = 300;
/** 目标离当前追击路径的终点超过这个距离时，重新寻路。 */
const REPATH_DISTANCE = 1;
/** 追击寻路的展开上限。目标都在附近，用不着搜很远。 */
const CHASE_PATH_EXPANSIONS = 1500;
/** 回到离出生位置这么近就算到家。 */
const HOME_DISTANCE = 0.6;
const DT = 1 / TICK_RATE;
const THINK_TICKS = Math.max(1, Math.round(MONSTER_THINK_MS / TICK_MS));

/** 怪物 AI 需要世界提供的能力。 */
export interface AiHost {
  readonly pathfinder: Pathfinder;
  /** 怪物视野（所在格和周围 8 格）里活着的玩家。返回的数组在下一次调用时会被复用。 */
  playersNear(m: Monster): readonly Player[];
  findPlayer(id: number): Player | undefined;
  inSafeZone(x: number, z: number): boolean;
  dealDamage(attacker: Entity, target: Entity, amount: number, now: number): void;
  /** 怪物的位置变了，更新 AOI 并通知视野变化。 */
  moved(m: Monster): void;
  /** 把怪物移出 AOI，周围的玩家收到 leave。 */
  hide(m: Monster): void;
  /** 把怪物放进 AOI，周围的玩家收到 enter。 */
  show(m: Monster): void;
}

/**
 * 怪物的行为：发现玩家、追击、攻击、脱战回家、死亡和重生。
 * 全部是同步计算，每个 tick 由世界调用一次 update。
 */
export class MonsterAi {
  /** 累计的怪物寻路次数。 */
  pathfinds = 0;
  private pathBudget = 0;

  constructor(private readonly host: AiHost) {}

  update(monsters: readonly Monster[], now: number): void {
    this.pathBudget = MAX_MONSTER_PATHFINDS_PER_TICK;
    for (const m of monsters) {
      if (m.dead) {
        this.updateDead(m, now);
        continue;
      }
      if (now >= m.nextThinkAt) {
        // 第一次决策之后按 id 错开，不让所有怪物挤在同一个 tick 做决策。
        const stagger = m.nextThinkAt < 0 ? (m.id % THINK_TICKS) * TICK_MS : 0;
        m.nextThinkAt = now + MONSTER_THINK_MS + stagger;
        this.think(m, now);
      }
      if (m.ai === 'chase') this.fight(m, now);
      if (m.path) {
        m.moving = stepMover(m, MONSTER_SPEED * DT);
        this.host.moved(m);
        if (m.ai === 'chase' && this.host.inSafeZone(m.x, m.z)) this.startReturn(m);
      } else {
        m.moving = false;
      }
      if (m.ai === 'return' && !m.path && distance(m.x, m.z, m.homeX, m.homeZ) < HOME_DISTANCE) this.arriveHome(m);
    }
  }

  /** 怪物被玩家打了：闲着的话就去追打它的人。 */
  onDamaged(m: Monster, attacker: Player): void {
    if (m.dead || m.ai !== 'idle') return;
    m.ai = 'chase';
    m.targetId = attacker.id;
    m.nextThinkAt = 0;
  }

  onDeath(m: Monster, now: number): void {
    m.ai = 'idle';
    m.targetId = 0;
    m.path = null;
    m.moving = false;
    m.hideAt = now + MONSTER_CORPSE_MS;
    m.respawnAt = now + MONSTER_RESPAWN_MS;
  }

  private think(m: Monster, now: number): void {
    if (m.ai === 'idle') {
      const target = this.findTarget(m);
      if (!target) return;
      m.ai = 'chase';
      m.targetId = target.id;
    }
    if (m.ai === 'chase') this.thinkChase(m, now);
    else if (!m.path) this.pathHome(m);
  }

  private findTarget(m: Monster): Player | null {
    let best: Player | null = null;
    let bestDistance = MONSTER_AGGRO_RADIUS;
    for (const p of this.host.playersNear(m)) {
      const d = distance(m.x, m.z, p.x, p.z);
      if (d <= bestDistance && !this.host.inSafeZone(p.x, p.z)) {
        best = p;
        bestDistance = d;
      }
    }
    return best;
  }

  private thinkChase(m: Monster, now: number): void {
    const target = this.host.findPlayer(m.targetId);
    if (
      !target ||
      target.dead ||
      this.host.inSafeZone(target.x, target.z) ||
      distance(m.x, m.z, m.homeX, m.homeZ) > MONSTER_LEASH_RADIUS ||
      distance(m.x, m.z, target.x, target.z) > MONSTER_LOSE_RADIUS
    ) {
      this.startReturn(m);
      return;
    }
    if (this.closeEnough(m, target)) return;
    const needPath = !m.path || distance(target.x, target.z, m.chaseX, m.chaseZ) > REPATH_DISTANCE;
    if (!needPath || now < m.nextPathAt) return;
    if (this.pathBudget === 0) {
      // 这个 tick 的寻路次数用完了：下个 tick 马上再试，不用等到下一次决策。
      m.nextThinkAt = now;
      return;
    }
    this.pathBudget--;
    this.pathfinds++;
    m.nextPathAt = now + REPATH_MS;
    const path = this.host.pathfinder.findPath(m.x, m.z, target.x, target.z, CHASE_PATH_EXPANSIONS);
    if (!path) {
      // 走不到目标那里（比如绕路太远），放弃。
      this.startReturn(m);
      return;
    }
    setPath(m, path);
    m.chaseX = target.x;
    m.chaseZ = target.z;
  }

  /** 每个 tick 都检查：贴近目标就站住，够得着就打。 */
  private fight(m: Monster, now: number): void {
    const target = this.host.findPlayer(m.targetId);
    if (!target || target.dead || this.host.inSafeZone(target.x, target.z)) return;
    if (distance(m.x, m.z, target.x, target.z) > ATTACK_RANGE) return;
    if (!this.host.pathfinder.lineOfSight(m.x, m.z, target.x, target.z)) return;
    if (this.closeEnough(m, target)) m.path = null;
    if (now < m.nextAttackAt) return;
    m.nextAttackAt = now + MONSTER_ATTACK_INTERVAL_MS;
    this.host.dealDamage(m, target, MONSTER_ATTACK_DAMAGE, now);
  }

  private closeEnough(m: Monster, target: Player): boolean {
    return (
      distance(m.x, m.z, target.x, target.z) <= MONSTER_STOP_DISTANCE &&
      this.host.pathfinder.lineOfSight(m.x, m.z, target.x, target.z)
    );
  }

  /** 放弃追击。回家途中不受伤害，并且马上回满血，免得被人反复拉出来磨血。 */
  private startReturn(m: Monster): void {
    m.ai = 'return';
    m.targetId = 0;
    m.hp = m.maxHp;
    m.path = null;
    this.pathHome(m);
  }

  private pathHome(m: Monster): void {
    if (distance(m.x, m.z, m.homeX, m.homeZ) < HOME_DISTANCE) return;
    if (this.pathBudget === 0) {
      // 这个 tick 的寻路次数用完了：先站着，下个 tick 再试。
      m.nextThinkAt = 0;
      return;
    }
    this.pathBudget--;
    this.pathfinds++;
    const path = this.host.pathfinder.findPath(m.x, m.z, m.homeX, m.homeZ);
    if (path) {
      setPath(m, path);
      return;
    }
    // 找不到回家的路（理论上不会发生）：直接放回出生位置，不让它卡在外面。
    this.host.hide(m);
    m.x = m.homeX;
    m.z = m.homeZ;
    this.host.show(m);
  }

  private arriveHome(m: Monster): void {
    m.ai = 'idle';
    m.hp = m.maxHp;
    m.moving = false;
  }

  private updateDead(m: Monster, now: number): void {
    if (m.inWorld && now >= m.hideAt) this.host.hide(m);
    if (now < m.respawnAt) return;
    if (m.inWorld) this.host.hide(m);
    m.x = m.homeX;
    m.z = m.homeZ;
    m.hp = m.maxHp;
    m.dead = false;
    m.ai = 'idle';
    m.targetId = 0;
    m.path = null;
    m.moving = false;
    m.nextThinkAt = now + MONSTER_THINK_MS;
    this.host.show(m);
  }
}

function distance(ax: number, az: number, bx: number, bz: number): number {
  return Math.hypot(ax - bx, az - bz);
}
