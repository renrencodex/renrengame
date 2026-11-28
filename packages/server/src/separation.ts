import {
  MONSTER_SEPARATION_DISTANCE,
  MONSTER_SEPARATION_SPEED,
  MONSTER_STOP_DISTANCE,
  TICK_RATE,
} from '@mmo/shared';
import type { Pathfinder, Point } from '@mmo/shared';
import type { Monster } from './entity';

const RANGE = MONSTER_SEPARATION_DISTANCE;
/** 一个 tick 最多推这么远。 */
const MAX_STEP = MONSTER_SEPARATION_SPEED / TICK_RATE;
/** 该推的距离比这个还小就不推了。否则快分开时怪物会一点一点地蹭很久，客户端上一直是跑步的动作。 */
const MIN_STEP = MAX_STEP * 0.06;
/** 怪物几乎站在目标身上时，绕着目标转挪不出多少地方，不推。 */
const MIN_ORBIT_RADIUS = 0.3;
/** 推开的方向在切线上的分量比这个小，就当作两只怪物在目标的同一条射线上。 */
const RADIAL_LIMIT = 0.1;
const EPSILON = 1e-6;

/** 怪物正在打的玩家，这里只关心他在哪、是否还活着。 */
export interface SeparationTarget {
  readonly x: number;
  readonly z: number;
  readonly dead: boolean;
}

/** 软分离需要世界提供的能力。AiHost 满足这个接口。 */
export interface SeparationHost {
  /** 怪物用的寻路器，安全区在它眼里是障碍，所以怪物不会被推进墙里或安全区里。 */
  readonly pathfinder: Pathfinder;
  findPlayer(id: number): SeparationTarget | undefined;
  /** 怪物的位置变了，更新 AOI 并通知视野变化。 */
  moved(m: Monster): void;
}

/**
 * 怪物之间的软分离：离得太近的怪物互相慢慢推开，不挡路，也不改变它们要去哪。
 *
 * 只有两种怪物会被推：
 * - 正在走路的：整体往旁边或后面挪，但不往前推，所以不会比 MONSTER_SPEED 更快；
 * - 已经站在目标旁边打的：只绕着目标转，离目标的距离不变。
 *   这样它不会因为被推出攻击距离又走回来，目标玩家也不用为了够着它来回挪。
 * 闲着的怪物不动（它不会自己走回出生位置），但别的怪物会被它推开。尸体不参与。
 *
 * 每只怪物都要和所有怪物比一遍。闲着的怪物在最外层就跳过了，
 * 现在的怪物数量下这点计算可以忽略；怪物多到上千只时要换成按格子找邻居。
 */
export class MonsterSeparation {
  /** 这个 tick 要挪动的怪物和新位置，三个一组：怪物在数组里的下标、x、z。 */
  private readonly pending: number[] = [];
  private outX = 0;
  private outZ = 0;

  update(monsters: readonly Monster[], host: SeparationHost): void {
    // 先按所有怪物现在的位置算完，再一起挪，这样结果和怪物的先后顺序无关。
    const pending = this.pending;
    pending.length = 0;
    for (let i = 0; i < monsters.length; i++) {
      const m = monsters[i];
      if (m.dead || !m.inWorld || m.ai === 'idle') continue;
      if (this.plan(m, monsters, host)) pending.push(i, this.outX, this.outZ);
    }
    for (let k = 0; k < pending.length; k += 3) {
      const m = monsters[pending[k]];
      m.x = pending[k + 1];
      m.z = pending[k + 2];
      host.moved(m);
    }
  }

  /** 算出 m 这个 tick 该挪到哪，写进 outX、outZ。不用挪时返回 false。 */
  private plan(m: Monster, monsters: readonly Monster[], host: SeparationHost): boolean {
    if (m.path) return this.planWalking(m, m.path[m.pathIndex], monsters, host.pathfinder);
    if (m.ai !== 'chase') return false;
    const target = host.findPlayer(m.targetId);
    if (!target || target.dead) return false;
    return this.planStanding(m, target, monsters, host.pathfinder);
  }

  /** 正在走向 next 的怪物：被旁边的怪物往外推，但去掉往前的那一部分。 */
  private planWalking(m: Monster, next: Point, monsters: readonly Monster[], pathfinder: Pathfinder): boolean {
    let ux = next.x - m.x;
    let uz = next.z - m.z;
    const ahead = Math.hypot(ux, uz);
    if (ahead > EPSILON) {
      ux /= ahead;
      uz /= ahead;
    } else {
      ux = 0;
      uz = 0;
    }

    let px = 0;
    let pz = 0;
    for (const n of monsters) {
      if (n === m || n.dead || !n.inWorld) continue;
      const dx = m.x - n.x;
      const dz = m.z - n.z;
      if (Math.abs(dx) >= RANGE || Math.abs(dz) >= RANGE) continue;
      const d = Math.hypot(dx, dz);
      if (d >= RANGE) continue;
      const weight = 1 - d / RANGE;
      if (d > EPSILON) {
        px += (dx / d) * weight;
        pz += (dz / d) * weight;
      } else {
        // 完全重合时没有“推开的方向”：按 id 一左一右让开。
        const side = m.id > n.id ? weight : -weight;
        px -= uz * side;
        pz += ux * side;
      }
    }

    const forward = px * ux + pz * uz;
    if (forward > 0) {
      px -= forward * ux;
      pz -= forward * uz;
    }
    const strength = Math.hypot(px, pz);
    const step = MAX_STEP * Math.min(1, strength);
    if (step < MIN_STEP) return false;
    const x = m.x + (px / strength) * step;
    const z = m.z + (pz / strength) * step;
    // 挪过去之后还要能直线走到下一个路径点，不然它接下来会蹭着墙走。
    if (!pathfinder.lineOfSight(m.x, m.z, x, z) || !pathfinder.lineOfSight(x, z, next.x, next.z)) return false;
    this.outX = x;
    this.outZ = z;
    return true;
  }

  /** 站在目标旁边的怪物：只绕着目标转，往哪边转看旁边的怪物在它的哪一侧。 */
  private planStanding(
    m: Monster,
    target: SeparationTarget,
    monsters: readonly Monster[],
    pathfinder: Pathfinder,
  ): boolean {
    const rx = m.x - target.x;
    const rz = m.z - target.z;
    const r = Math.hypot(rx, rz);
    // 比站定的距离还远，说明它不是“站在目标旁边”，只是暂时没有路（比如在等寻路的额度）。
    if (r < MIN_ORBIT_RADIUS || r > MONSTER_STOP_DISTANCE) return false;
    // 绕目标逆时针转时的前进方向。
    const tx = -rz / r;
    const tz = rx / r;

    let turn = 0;
    for (const n of monsters) {
      if (n === m || n.dead || !n.inWorld) continue;
      const dx = m.x - n.x;
      const dz = m.z - n.z;
      if (Math.abs(dx) >= RANGE || Math.abs(dz) >= RANGE) continue;
      const d = Math.hypot(dx, dz);
      if (d >= RANGE) continue;
      const weight = 1 - d / RANGE;
      const along = d > EPSILON ? (dx * tx + dz * tz) / d : 0;
      if (Math.abs(along) >= RADIAL_LIMIT) {
        turn += along > 0 ? weight : -weight;
      } else if ((n.x - target.x) * rx + (n.z - target.z) * rz > 0) {
        // 一前一后站在目标的同一侧（同一个方向追过来的怪物就是这样）：按 id 一个往左、一个往右。
        turn += m.id > n.id ? weight : -weight;
      }
      // 剩下的情况是对方在目标的另一侧：已经是能离开的最远位置，再转只会靠近。
    }

    const step = MAX_STEP * Math.min(1, Math.abs(turn));
    if (step < MIN_STEP) return false;
    const angle = (turn > 0 ? step : -step) / r;
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    const x = target.x + rx * cos - rz * sin;
    const z = target.z + rx * sin + rz * cos;
    // 新位置要仍然看得见目标，不然它就打不到了。目标在安全区里时这里也通不过，怪物本来就要放弃了。
    if (!pathfinder.lineOfSight(m.x, m.z, x, z) || !pathfinder.lineOfSight(x, z, target.x, target.z)) return false;
    this.outX = x;
    this.outZ = z;
    return true;
  }
}
