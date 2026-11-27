export interface Sample {
  x: number;
  z: number;
  moving: boolean;
}

interface Snap extends Sample {
  time: number;
}

const MAX_SNAPS = 32;

/**
 * 其他玩家的快照缓冲。
 *
 * 快照每秒只有 10 个，直接用会一顿一顿的。这里把收到的快照按服务器时间存起来，
 * 渲染时取“稍早一点”的时刻，在前后两个快照之间插值，换来平滑的移动。
 */
export class SnapshotBuffer {
  private readonly snaps: Snap[] = [];

  push(time: number, x: number, z: number, moving: boolean): void {
    const last: Snap | undefined = this.snaps[this.snaps.length - 1];
    if (last && time <= last.time) {
      // 时间没有前进（比如对时还不准）：用新状态覆盖最后一个，保持时间有序。
      last.x = x;
      last.z = z;
      last.moving = moving;
      return;
    }
    this.snaps.push({ time, x, z, moving });
    if (this.snaps.length > MAX_SNAPS) this.snaps.shift();
  }

  /** 取 renderTime 时刻的状态写入 out。缓冲为空时返回 false。 */
  sample(renderTime: number, out: Sample): boolean {
    const snaps = this.snaps;
    if (snaps.length === 0) return false;

    let i = snaps.length - 1;
    while (i > 0 && snaps[i].time > renderTime) i--;
    const a = snaps[i];
    const b: Snap | undefined = snaps[i + 1];

    if (!b || renderTime <= a.time) {
      // 比最早的快照还早，或者已经超过最新的快照：停在已知的位置，不做外推。
      out.x = a.x;
      out.z = a.z;
      out.moving = a.moving;
      return true;
    }

    const t = (renderTime - a.time) / (b.time - a.time);
    out.x = a.x + (b.x - a.x) * t;
    out.z = a.z + (b.z - a.z) * t;
    out.moving = a.moving || a.x !== b.x || a.z !== b.z;
    return true;
  }
}
