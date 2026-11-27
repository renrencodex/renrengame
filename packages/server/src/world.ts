import {
  AOI_CELL_SIZE,
  isValidMoveTarget,
  isWalkable,
  MAX_PATHFINDS_PER_TICK,
  MOVE_MIN_INTERVAL_MS,
  MOVE_SPEED,
  Pathfinder,
  sanitizeName,
  setPath,
  SNAPSHOT_EVERY_TICKS,
  SPAWN_RADIUS,
  stepMover,
  TICK_RATE,
} from '@mmo/shared';
import type { EntityInfo, GameMap, Mover, Point, ServerMsg, SnapEntity } from '@mmo/shared';
import { AoiGrid } from './aoi';
import type { CellChange } from './aoi';

/** 世界向某个玩家发消息的出口。世界本身不关心底层是 WebSocket 还是别的。 */
export interface Connection {
  send(msg: ServerMsg): void;
}

interface Player extends Mover {
  readonly id: number;
  readonly name: string;
  readonly conn: Connection;
  moving: boolean;
  /** 已通过校验、还没寻路的目标。新的 moveTo 会覆盖旧的。 */
  pendingTarget: Point | null;
  queued: boolean;
  lastPathAt: number;
}

export interface WorldStats {
  /** 累计完成的寻路次数。 */
  pathfinds: number;
  /** 因为每 tick 上限或个人间隔而推迟到后面 tick 的次数。 */
  deferredPathfinds: number;
  /** 没通过校验的 moveTo 数量。 */
  rejectedMoves: number;
}

const DT = 1 / TICK_RATE;

/**
 * 权威的游戏世界：所有位置都由这里计算，客户端只能提交“想去哪”。
 */
export class World {
  readonly map: GameMap;
  readonly stats: WorldStats = { pathfinds: 0, deferredPathfinds: 0, rejectedMoves: 0 };
  private readonly pathfinder: Pathfinder;
  private readonly aoi: AoiGrid;
  private readonly players = new Map<number, Player>();
  private pathQueue: Player[] = [];
  private nextId = 1;
  private tickCount = 0;

  constructor(map: GameMap) {
    this.map = map;
    this.pathfinder = new Pathfinder(map);
    this.aoi = new AoiGrid(map.size, AOI_CELL_SIZE);
  }

  get playerCount(): number {
    return this.players.size;
  }

  getPlayer(id: number): { x: number; z: number; moving: boolean; name: string } | undefined {
    const p = this.players.get(id);
    return p ? { x: p.x, z: p.z, moving: p.moving, name: p.name } : undefined;
  }

  /** 玩家进入世界。spawn 只在测试里用来指定出生点。 */
  join(name: string, conn: Connection, now: number, spawn?: Point): number {
    const id = this.nextId++;
    const pos = spawn ?? this.randomSpawn();
    const player: Player = {
      id,
      name: sanitizeName(name, `玩家${id}`),
      conn,
      x: pos.x,
      z: pos.z,
      path: null,
      pathIndex: 0,
      moving: false,
      pendingTarget: null,
      queued: false,
      lastPathAt: -Infinity,
    };
    this.players.set(id, player);
    const cell = this.aoi.add(id, pos.x, pos.z);

    conn.send({ t: 'welcome', selfId: id, seed: this.map.seed, serverTime: now });

    const visible: EntityInfo[] = [];
    const selfEnter: ServerMsg = { t: 'enter', entities: [info(player)] };
    for (const c of this.aoi.neighbors(cell)) {
      for (const otherId of this.aoi.idsIn(c)) {
        const other = this.players.get(otherId) as Player;
        visible.push(info(other));
        if (other !== player) other.conn.send(selfEnter);
      }
    }
    conn.send({ t: 'enter', entities: visible });
    return id;
  }

  leave(id: number): void {
    const player = this.players.get(id);
    if (!player) return;
    this.players.delete(id);
    const cell = this.aoi.remove(id);
    if (cell === undefined) return;
    const msg: ServerMsg = { t: 'leave', ids: [id] };
    for (const c of this.aoi.neighbors(cell)) {
      for (const otherId of this.aoi.idsIn(c)) this.players.get(otherId)?.conn.send(msg);
    }
  }

  /**
   * 玩家请求移动到 (x, z)。校验通过后排队等待寻路，返回是否接受。
   * 寻路放到 tick 里做，并且每个 tick 有次数上限，避免很多人同时点击时卡住整个世界。
   */
  moveTo(id: number, x: number, z: number): boolean {
    const p = this.players.get(id);
    if (!p) return false;
    if (!isValidMoveTarget(this.map, p.x, p.z, x, z)) {
      this.stats.rejectedMoves++;
      return false;
    }
    p.pendingTarget = { x, z };
    if (!p.queued) {
      p.queued = true;
      this.pathQueue.push(p);
    }
    return true;
  }

  /** 推进一个固定步长（1 / TICK_RATE 秒）。now 是这个 tick 对应的服务器时间。 */
  tick(now: number): void {
    this.tickCount++;
    this.processPathQueue(now);

    for (const p of this.players.values()) {
      if (!p.path) continue;
      p.moving = stepMover(p, MOVE_SPEED * DT);
      const change = this.aoi.move(p.id, p.x, p.z);
      if (change) this.onCellChange(p, change);
    }

    if (this.tickCount % SNAPSHOT_EVERY_TICKS === 0) this.sendSnapshots(now);
  }

  private processPathQueue(now: number): void {
    const queue = this.pathQueue;
    if (queue.length === 0) return;
    this.pathQueue = [];
    let budget = MAX_PATHFINDS_PER_TICK;
    for (const p of queue) {
      // 已经离线的玩家直接丢掉。
      if (this.players.get(p.id) !== p) continue;
      const target = p.pendingTarget;
      if (!target) {
        p.queued = false;
        continue;
      }
      if (budget === 0 || now - p.lastPathAt < MOVE_MIN_INTERVAL_MS) {
        this.stats.deferredPathfinds++;
        this.pathQueue.push(p);
        continue;
      }
      budget--;
      p.queued = false;
      p.pendingTarget = null;
      p.lastPathAt = now;
      this.stats.pathfinds++;
      const path = this.pathfinder.findPath(p.x, p.z, target.x, target.z);
      // 找不到路时保持原来的移动。客户端预测用的是同一套规则。
      if (path) {
        setPath(p, path);
        p.moving = p.path !== null;
      }
    }
  }

  /** 玩家跨格后，和新进入、离开视野的实体互相通知。 */
  private onCellChange(p: Player, change: CellChange): void {
    if (change.entered.length > 0) {
      const selfEnter: ServerMsg = { t: 'enter', entities: [info(p)] };
      const entered: EntityInfo[] = [];
      for (const c of change.entered) {
        for (const otherId of this.aoi.idsIn(c)) {
          const other = this.players.get(otherId);
          if (!other || other === p) continue;
          entered.push(info(other));
          other.conn.send(selfEnter);
        }
      }
      if (entered.length > 0) p.conn.send({ t: 'enter', entities: entered });
    }
    if (change.left.length > 0) {
      const selfLeave: ServerMsg = { t: 'leave', ids: [p.id] };
      const left: number[] = [];
      for (const c of change.left) {
        for (const otherId of this.aoi.idsIn(c)) {
          const other = this.players.get(otherId);
          if (!other || other === p) continue;
          left.push(otherId);
          other.conn.send(selfLeave);
        }
      }
      if (left.length > 0) p.conn.send({ t: 'leave', ids: left });
    }
  }

  /**
   * 给每个玩家下发视野内所有实体（包括自己）的位置。
   * 同一个格子里的玩家视野相同，所以每个格子只组装一次消息，发送端也只序列化一次。
   */
  private sendSnapshots(now: number): void {
    const cellEntities = new Map<number, SnapEntity[]>();
    const cellMessages = new Map<number, ServerMsg>();

    const entitiesIn = (cell: number): SnapEntity[] => {
      let list = cellEntities.get(cell);
      if (!list) {
        list = [];
        for (const id of this.aoi.idsIn(cell)) {
          const e = this.players.get(id) as Player;
          list.push([e.id, round2(e.x), round2(e.z), e.moving ? 1 : 0]);
        }
        cellEntities.set(cell, list);
      }
      return list;
    };

    for (const p of this.players.values()) {
      const cell = this.aoi.cellOf(p.id) as number;
      let msg = cellMessages.get(cell);
      if (!msg) {
        const entities: SnapEntity[] = [];
        for (const c of this.aoi.neighbors(cell)) {
          for (const e of entitiesIn(c)) entities.push(e);
        }
        msg = { t: 'snap', time: now, entities };
        cellMessages.set(cell, msg);
      }
      p.conn.send(msg);
    }
  }

  private randomSpawn(): Point {
    const center = this.map.size / 2;
    for (let i = 0; i < 50; i++) {
      const angle = Math.random() * Math.PI * 2;
      const r = SPAWN_RADIUS * Math.sqrt(Math.random());
      const x = center + Math.cos(angle) * r;
      const z = center + Math.sin(angle) * r;
      if (isWalkable(this.map, x, z)) return { x, z };
    }
    return { x: center + 0.5, z: center + 0.5 };
  }
}

function info(p: Player): EntityInfo {
  return { id: p.id, name: p.name, x: round2(p.x), z: round2(p.z), moving: p.moving };
}

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}
