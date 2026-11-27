import { MAX_PATH_EXPANSIONS } from './constants';
import type { GameMap } from './map';

export interface Point {
  x: number;
  z: number;
}

/** 做视线检查时把角色当成这个半径的圆，避免平滑后的路径紧贴墙角。 */
const AGENT_RADIUS = 0.3;
const SQRT2 = Math.SQRT2;
const NEIGHBOR_X = [1, -1, 0, 0, 1, 1, -1, -1];
const NEIGHBOR_Z = [0, 0, 1, -1, 1, -1, 1, -1];

/**
 * 网格 A* 寻路，带路径平滑。
 *
 * 前后端用同一份实现，所以客户端预测出的路径和服务端算出的一致。
 * 每个实例复用内部缓冲区，一张地图只需要创建一个。
 */
export class Pathfinder {
  private readonly size: number;
  private readonly blocked: Uint8Array;
  private readonly g: Float64Array;
  private readonly parent: Int32Array;
  /** seen[i] === searchId 表示 g[i] 在本次搜索中有效。 */
  private readonly seen: Uint32Array;
  private readonly closed: Uint32Array;
  private searchId = 0;
  private readonly heapNode: number[] = [];
  private readonly heapF: number[] = [];

  constructor(map: GameMap) {
    this.size = map.size;
    this.blocked = map.blocked;
    const n = map.size * map.size;
    this.g = new Float64Array(n);
    this.parent = new Int32Array(n);
    this.seen = new Uint32Array(n);
    this.closed = new Uint32Array(n);
  }

  /**
   * 返回从起点到终点的折线，第一个点是起点，最后一个点是终点。
   * 终点不可达、不可行走或搜索超出上限时返回 null。
   */
  findPath(sx: number, sz: number, tx: number, tz: number, maxExpansions = MAX_PATH_EXPANSIONS): Point[] | null {
    if (!Number.isFinite(sx + sz + tx + tz)) return null;
    const size = this.size;
    const scx = Math.floor(sx);
    const scz = Math.floor(sz);
    const tcx = Math.floor(tx);
    const tcz = Math.floor(tz);
    if (this.cellBlocked(scx, scz) || this.cellBlocked(tcx, tcz)) return null;

    const start: Point = { x: sx, z: sz };
    const target: Point = { x: tx, z: tz };
    if ((scx === tcx && scz === tcz) || this.lineOfSight(sx, sz, tx, tz)) return [start, target];

    const cells = this.search(scz * size + scx, tcz * size + tcx, maxExpansions);
    if (!cells) return null;

    const points: Point[] = [start];
    for (let i = 1; i < cells.length - 1; i++) {
      const c = cells[i];
      points.push({ x: (c % size) + 0.5, z: Math.floor(c / size) + 0.5 });
    }
    points.push(target);
    return this.smooth(points);
  }

  /** 两点之间能否直线通行（按角色半径留出余量）。 */
  lineOfSight(x0: number, z0: number, x1: number, z1: number): boolean {
    const dx = x1 - x0;
    const dz = z1 - z0;
    const len = Math.hypot(dx, dz);
    if (len < 1e-9) return !this.cellBlocked(Math.floor(x0), Math.floor(z0));
    const ox = (-dz / len) * AGENT_RADIUS;
    const oz = (dx / len) * AGENT_RADIUS;
    return (
      this.rayClear(x0, z0, x1, z1) &&
      this.rayClear(x0 + ox, z0 + oz, x1 + ox, z1 + oz) &&
      this.rayClear(x0 - ox, z0 - oz, x1 - ox, z1 - oz)
    );
  }

  private cellBlocked(cx: number, cz: number): boolean {
    return cx < 0 || cz < 0 || cx >= this.size || cz >= this.size || this.blocked[cz * this.size + cx] === 1;
  }

  /** 沿线段逐格检查（Amanatides-Woo 网格遍历），线段经过的格子都可行走时返回 true。 */
  private rayClear(x0: number, z0: number, x1: number, z1: number): boolean {
    let cx = Math.floor(x0);
    let cz = Math.floor(z0);
    if (this.cellBlocked(cx, cz)) return false;

    const dx = x1 - x0;
    const dz = z1 - z0;
    const stepX = dx > 0 ? 1 : dx < 0 ? -1 : 0;
    const stepZ = dz > 0 ? 1 : dz < 0 ? -1 : 0;
    const tDeltaX = stepX !== 0 ? Math.abs(1 / dx) : Infinity;
    const tDeltaZ = stepZ !== 0 ? Math.abs(1 / dz) : Infinity;
    let tMaxX = stepX > 0 ? (cx + 1 - x0) / dx : stepX < 0 ? (cx - x0) / dx : Infinity;
    let tMaxZ = stepZ > 0 ? (cz + 1 - z0) / dz : stepZ < 0 ? (cz - z0) / dz : Infinity;

    while (tMaxX <= 1 || tMaxZ <= 1) {
      if (tMaxX < tMaxZ) {
        cx += stepX;
        tMaxX += tDeltaX;
      } else if (tMaxZ < tMaxX) {
        cz += stepZ;
        tMaxZ += tDeltaZ;
      } else {
        // 正好穿过格子的角：两侧的格子都要可行走。
        if (this.cellBlocked(cx + stepX, cz) || this.cellBlocked(cx, cz + stepZ)) return false;
        cx += stepX;
        cz += stepZ;
        tMaxX += tDeltaX;
        tMaxZ += tDeltaZ;
      }
      if (this.cellBlocked(cx, cz)) return false;
    }
    return true;
  }

  /** 八方向 A*，不允许斜着擦过障碍物的角。返回从起点到终点的格子下标。 */
  private search(startIdx: number, goalIdx: number, maxExpansions: number): number[] | null {
    const { size, blocked, g, parent, seen, closed } = this;
    const id = ++this.searchId;
    const goalX = goalIdx % size;
    const goalZ = Math.floor(goalIdx / size);

    this.heapNode.length = 0;
    this.heapF.length = 0;
    g[startIdx] = 0;
    parent[startIdx] = -1;
    seen[startIdx] = id;
    this.heapPush(startIdx, heuristic(startIdx % size, Math.floor(startIdx / size), goalX, goalZ));

    let expansions = 0;
    while (this.heapNode.length > 0) {
      const cur = this.heapPop();
      if (closed[cur] === id) continue;
      if (cur === goalIdx) return this.reconstruct(cur);
      closed[cur] = id;
      if (++expansions > maxExpansions) return null;

      const cx = cur % size;
      const cz = Math.floor(cur / size);
      const gCur = g[cur];
      for (let i = 0; i < 8; i++) {
        const nx = cx + NEIGHBOR_X[i];
        const nz = cz + NEIGHBOR_Z[i];
        if (nx < 0 || nz < 0 || nx >= size || nz >= size) continue;
        const n = nz * size + nx;
        if (blocked[n] === 1 || closed[n] === id) continue;
        const diagonal = i >= 4;
        if (diagonal && (blocked[cz * size + nx] === 1 || blocked[nz * size + cx] === 1)) continue;
        const ng = gCur + (diagonal ? SQRT2 : 1);
        if (seen[n] === id && ng >= g[n]) continue;
        g[n] = ng;
        parent[n] = cur;
        seen[n] = id;
        this.heapPush(n, ng + heuristic(nx, nz, goalX, goalZ));
      }
    }
    return null;
  }

  private reconstruct(goalIdx: number): number[] {
    const cells: number[] = [];
    for (let c = goalIdx; c !== -1; c = this.parent[c]) cells.push(c);
    return cells.reverse();
  }

  /** 去掉多余的拐点：能直线走到的中间点都跳过。 */
  private smooth(points: Point[]): Point[] {
    if (points.length <= 2) return points;
    const out: Point[] = [points[0]];
    let anchor = points[0];
    for (let i = 2; i < points.length; i++) {
      const p = points[i];
      if (!this.lineOfSight(anchor.x, anchor.z, p.x, p.z)) {
        anchor = points[i - 1];
        out.push(anchor);
      }
    }
    out.push(points[points.length - 1]);
    return out;
  }

  private heapPush(node: number, f: number): void {
    const nodes = this.heapNode;
    const fs = this.heapF;
    let i = nodes.length;
    nodes.push(node);
    fs.push(f);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (fs[p] <= f) break;
      nodes[i] = nodes[p];
      fs[i] = fs[p];
      i = p;
    }
    nodes[i] = node;
    fs[i] = f;
  }

  private heapPop(): number {
    const nodes = this.heapNode;
    const fs = this.heapF;
    const top = nodes[0];
    const lastNode = nodes.pop() as number;
    const lastF = fs.pop() as number;
    const n = nodes.length;
    if (n > 0) {
      let i = 0;
      for (;;) {
        let c = 2 * i + 1;
        if (c >= n) break;
        if (c + 1 < n && fs[c + 1] < fs[c]) c++;
        if (fs[c] >= lastF) break;
        nodes[i] = nodes[c];
        fs[i] = fs[c];
        i = c;
      }
      nodes[i] = lastNode;
      fs[i] = lastF;
    }
    return top;
  }
}

/** 八方向距离，略微放大以减少等代价格子的展开。 */
function heuristic(x: number, z: number, goalX: number, goalZ: number): number {
  const dx = Math.abs(x - goalX);
  const dz = Math.abs(z - goalZ);
  return (dx + dz + (SQRT2 - 2) * Math.min(dx, dz)) * 1.001;
}
