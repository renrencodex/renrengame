import { CLIENT_ATTACK_RANGE } from '@mmo/shared';
import type { Point } from '@mmo/shared';

/** 追击时重新下达移动命令的最短间隔。 */
const REORDER_MS = 250;
/** 目标离上一次命令的终点超过这么远，才重新下达命令。 */
const REORDER_DISTANCE = 1;
/**
 * 已经站定时，目标离开这么远才重新追上去。
 * 比开始站定的距离（CLIENT_ATTACK_RANGE）大、比服务端的攻击距离小，目标稍微挪动时不用跟着来回走。
 */
const HOLD_RANGE = 1.8;

export interface SelfState extends Point {
  moving: boolean;
}

/**
 * 追击目标的逻辑。
 *
 * 服务端只判定伤害（目标活着、玩家站定、距离够近、中间没有墙），不会替玩家走路。
 * 所以由客户端负责把角色带到目标旁边：目标远了就朝它走，走到攻击距离内就停下。
 * 这里不直接移动角色，只返回“现在应该走去哪”，调用方像处理一次普通的点击那样去执行。
 */
export class Targeting {
  /** 当前的目标，0 表示没有。 */
  targetId = 0;
  private lastOrderAt = -Infinity;
  private orderX = 0;
  private orderZ = 0;
  private hasOrder = false;

  constructor(private readonly lineOfSight: (ax: number, az: number, bx: number, bz: number) => boolean) {}

  set(id: number): void {
    if (id === this.targetId) return;
    this.targetId = id;
    this.lastOrderAt = -Infinity;
    this.hasOrder = false;
  }

  clear(): void {
    this.set(0);
  }

  /**
   * 每帧调用。返回需要走去的位置；不需要下达新命令时返回 null。
   * 返回的位置等于自己当前的位置时，意思是“原地停下”。
   */
  update(now: number, self: SelfState, target: Point): Point | null {
    if (this.targetId === 0) return null;
    const distance = Math.hypot(target.x - self.x, target.z - self.z);
    const visible = this.lineOfSight(self.x, self.z, target.x, target.z);

    if (visible && distance <= CLIENT_ATTACK_RANGE) {
      // 够近了：还在走就停下，服务端只在站定时结算攻击。
      this.hasOrder = false;
      return self.moving ? { x: self.x, z: self.z } : null;
    }
    if (!self.moving) {
      if (visible && distance <= HOLD_RANGE) return null;
      // 没在走（刚选中目标、目标走开了，或者上一次命令没有成功）：需要重新出发。
      this.hasOrder = false;
    }
    if (this.hasOrder && Math.hypot(target.x - this.orderX, target.z - this.orderZ) <= REORDER_DISTANCE) return null;
    if (now - this.lastOrderAt < REORDER_MS) return null;

    this.lastOrderAt = now;
    this.orderX = target.x;
    this.orderZ = target.z;
    this.hasOrder = true;
    return { x: target.x, z: target.z };
  }
}
