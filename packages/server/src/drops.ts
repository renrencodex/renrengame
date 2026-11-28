import type { Drop } from './entity';

/**
 * 地上物品的空间索引。
 *
 * AOI 的格子很大（一格里可能有几十个物品），而拾取只关心脚边一两米，
 * 所以另外按小格子存一份：每个玩家每个 tick 只需要看自己所在的小格和周围 8 格。
 * 小格的边长不能小于拾取半径，否则周围 8 格盖不住拾取范围。
 */
export class DropGrid {
  private readonly cols: number;
  private readonly cells = new Map<number, Drop[]>();

  constructor(
    mapSize: number,
    private readonly cellSize: number,
  ) {
    this.cols = Math.ceil(mapSize / cellSize);
  }

  add(drop: Drop): void {
    const key = this.keyAt(drop.x, drop.z);
    const list = this.cells.get(key);
    if (list) list.push(drop);
    else this.cells.set(key, [drop]);
  }

  remove(drop: Drop): void {
    const key = this.keyAt(drop.x, drop.z);
    const list = this.cells.get(key);
    if (!list) return;
    const index = list.indexOf(drop);
    if (index < 0) return;
    list[index] = list[list.length - 1];
    list.pop();
    if (list.length === 0) this.cells.delete(key);
  }

  /** 把 (x, z) 所在小格和周围 8 格里的物品放进 out（先清空），并返回 out。 */
  near(x: number, z: number, out: Drop[]): Drop[] {
    out.length = 0;
    const cx = this.clamp(Math.floor(x / this.cellSize));
    const cz = this.clamp(Math.floor(z / this.cellSize));
    for (let dz = -1; dz <= 1; dz++) {
      const nz = cz + dz;
      if (nz < 0 || nz >= this.cols) continue;
      for (let dx = -1; dx <= 1; dx++) {
        const nx = cx + dx;
        if (nx < 0 || nx >= this.cols) continue;
        const list = this.cells.get(nz * this.cols + nx);
        if (list) for (const drop of list) out.push(drop);
      }
    }
    return out;
  }

  private keyAt(x: number, z: number): number {
    return this.clamp(Math.floor(z / this.cellSize)) * this.cols + this.clamp(Math.floor(x / this.cellSize));
  }

  private clamp(c: number): number {
    return Math.min(this.cols - 1, Math.max(0, c));
  }
}
