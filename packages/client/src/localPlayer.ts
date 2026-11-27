import {
  CLIENT_MOVE_DISTANCE,
  CORRECTION_THRESHOLD,
  isValidMoveTarget,
  MOVE_SPEED,
  Pathfinder,
  setPath,
  stepMover,
} from '@mmo/shared';
import type { GameMap, Mover, Point } from '@mmo/shared';

interface TrailPoint extends Point {
  time: number;
}

/** 记住最近这么久走过的位置，用来判断服务端是不是只是比本地慢一点。 */
const TRAIL_MS = 2000;
const TRAIL_SPACING = 0.25;
/** 跟随服务端位置时的平滑程度。 */
const FOLLOW_SHARPNESS = 10;
const SETTLED_DISTANCE = 0.05;

/**
 * 本地玩家：点击后不等服务器，立刻按同一套寻路规则开始走（本地预测）。
 *
 * 服务端收到 moveTo 有延迟，所以它的位置总是落在本地位置后面一小段。
 * 只要服务端位置在本地“最近走过的轨迹”或“接下来要走的路径”附近，就认为预测是对的。
 * 偏离太远时放弃预测，改为平滑地跟随服务端位置，直到追上为止。
 */
export class LocalPlayer implements Mover {
  x = 0;
  z = 0;
  path: Point[] | null = null;
  pathIndex = 0;
  moving = false;
  /** 预测被服务端纠正的次数。 */
  corrections = 0;

  private readonly pathfinder: Pathfinder;
  private trail: TrailPoint[] = [];
  private following = false;
  private serverX = 0;
  private serverZ = 0;
  private serverMoving = false;

  constructor(private readonly map: GameMap) {
    this.pathfinder = new Pathfinder(map);
  }

  /** 直接放到某个位置（进入世界时）。 */
  place(x: number, z: number): void {
    this.x = x;
    this.z = z;
    this.serverX = x;
    this.serverZ = z;
    this.serverMoving = false;
    this.path = null;
    this.moving = false;
    this.following = false;
    this.trail = [];
  }

  /** 尝试朝 (x, z) 移动。目标无效或走不到时返回 false，这时不应该发给服务器。 */
  requestMove(x: number, z: number): boolean {
    if (!isValidMoveTarget(this.map, this.x, this.z, x, z, CLIENT_MOVE_DISTANCE)) return false;
    const path = this.pathfinder.findPath(this.x, this.z, x, z);
    if (!path) return false;
    setPath(this, path);
    this.following = false;
    return true;
  }

  /** 收到快照里自己的权威位置。 */
  onServerState(x: number, z: number, moving: boolean): void {
    this.serverX = x;
    this.serverZ = z;
    this.serverMoving = moving;
    if (this.following) return;
    if (this.distanceToPrediction(x, z) > CORRECTION_THRESHOLD) {
      this.following = true;
      this.path = null;
      this.corrections++;
    }
  }

  update(dt: number, now: number): void {
    if (this.following) {
      const dx = this.serverX - this.x;
      const dz = this.serverZ - this.z;
      const k = 1 - Math.exp(-FOLLOW_SHARPNESS * dt);
      this.x += dx * k;
      this.z += dz * k;
      const settled = Math.hypot(dx, dz) < SETTLED_DISTANCE;
      this.moving = !settled;
      // 追上了而且服务端也停了：回到正常的预测模式。
      if (settled && !this.serverMoving) this.following = false;
    } else {
      this.moving = stepMover(this, MOVE_SPEED * dt);
    }
    this.recordTrail(now);
  }

  private recordTrail(now: number): void {
    const trail = this.trail;
    while (trail.length > 0 && trail[0].time < now - TRAIL_MS) trail.shift();
    const last: TrailPoint | undefined = trail[trail.length - 1];
    if (!last || Math.hypot(this.x - last.x, this.z - last.z) >= TRAIL_SPACING) {
      trail.push({ x: this.x, z: this.z, time: now });
    }
  }

  /** (x, z) 到本地预测轨迹的最近距离：当前位置、最近走过的点、接下来要走的路径。 */
  private distanceToPrediction(x: number, z: number): number {
    let best = Math.hypot(x - this.x, z - this.z);
    for (const p of this.trail) best = Math.min(best, Math.hypot(x - p.x, z - p.z));
    if (this.path) {
      let ax = this.x;
      let az = this.z;
      for (let i = this.pathIndex; i < this.path.length; i++) {
        const b = this.path[i];
        best = Math.min(best, distanceToSegment(x, z, ax, az, b.x, b.z));
        ax = b.x;
        az = b.z;
      }
    }
    return best;
  }
}

function distanceToSegment(px: number, pz: number, ax: number, az: number, bx: number, bz: number): number {
  const dx = bx - ax;
  const dz = bz - az;
  const lengthSq = dx * dx + dz * dz;
  const t = lengthSq > 0 ? Math.min(1, Math.max(0, ((px - ax) * dx + (pz - az) * dz) / lengthSq)) : 0;
  return Math.hypot(px - (ax + dx * t), pz - (az + dz * t));
}
