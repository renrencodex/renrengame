export interface CellChange {
  from: number;
  to: number;
  /** 移动后新进入视野的格子。 */
  entered: number[];
  /** 移动后离开视野的格子。 */
  left: number[];
}

/**
 * 九宫格 AOI（Area of Interest）。
 *
 * 地图按固定边长划成格子，每个实体属于一个格子，能看到自己所在格和周围 8 格里的实体。
 * 这样同步量只和附近的人数有关，和全图总人数无关。
 */
export class AoiGrid {
  readonly cols: number;
  private readonly cellSize: number;
  private readonly cells: Set<number>[] = [];
  private readonly neighborList: number[][] = [];
  private readonly entityCell = new Map<number, number>();

  constructor(mapSize: number, cellSize: number) {
    this.cellSize = cellSize;
    this.cols = Math.ceil(mapSize / cellSize);
    const cols = this.cols;
    for (let cz = 0; cz < cols; cz++) {
      for (let cx = 0; cx < cols; cx++) {
        this.cells.push(new Set());
        const neighbors: number[] = [];
        for (let dz = -1; dz <= 1; dz++) {
          for (let dx = -1; dx <= 1; dx++) {
            const nx = cx + dx;
            const nz = cz + dz;
            if (nx >= 0 && nz >= 0 && nx < cols && nz < cols) neighbors.push(nz * cols + nx);
          }
        }
        this.neighborList.push(neighbors);
      }
    }
  }

  cellAt(x: number, z: number): number {
    const max = this.cols - 1;
    const cx = Math.min(max, Math.max(0, Math.floor(x / this.cellSize)));
    const cz = Math.min(max, Math.max(0, Math.floor(z / this.cellSize)));
    return cz * this.cols + cx;
  }

  add(id: number, x: number, z: number): number {
    const cell = this.cellAt(x, z);
    this.cells[cell].add(id);
    this.entityCell.set(id, cell);
    return cell;
  }

  /** 移除实体，返回它原来所在的格子。 */
  remove(id: number): number | undefined {
    const cell = this.entityCell.get(id);
    if (cell === undefined) return undefined;
    this.cells[cell].delete(id);
    this.entityCell.delete(id);
    return cell;
  }

  /** 更新实体位置。没有跨格时返回 null，跨格时返回视野的变化。 */
  move(id: number, x: number, z: number): CellChange | null {
    const from = this.entityCell.get(id);
    if (from === undefined) return null;
    const to = this.cellAt(x, z);
    if (to === from) return null;
    this.cells[from].delete(id);
    this.cells[to].add(id);
    this.entityCell.set(id, to);
    const before = this.neighborList[from];
    const after = this.neighborList[to];
    return {
      from,
      to,
      entered: after.filter((c) => !before.includes(c)),
      left: before.filter((c) => !after.includes(c)),
    };
  }

  cellOf(id: number): number | undefined {
    return this.entityCell.get(id);
  }

  /** 某个格子的视野范围：它自己和周围最多 8 个格子。 */
  neighbors(cell: number): readonly number[] {
    return this.neighborList[cell];
  }

  idsIn(cell: number): ReadonlySet<number> {
    return this.cells[cell];
  }
}
