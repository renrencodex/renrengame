import { describe, expect, it } from 'vitest';
import {
  emptyMap,
  MONSTER_SEPARATION_DISTANCE,
  MONSTER_SEPARATION_SPEED,
  MONSTER_SPEED,
  MONSTER_STOP_DISTANCE,
  Pathfinder,
  TICK_MS,
  TICK_RATE,
} from '@mmo/shared';
import type { Point, ServerMsg, SnapEntity } from '@mmo/shared';
import type { Monster } from '../src/entity';
import { MonsterSeparation } from '../src/separation';
import type { SeparationHost } from '../src/separation';
import { World } from '../src/world';
import type { Connection } from '../src/world';

const MAX_STEP = MONSTER_SEPARATION_SPEED / TICK_RATE;
/** 推到快要分开时就停了（见 separation.ts 的 MIN_STEP），所以“分开了”按这个距离算。 */
const APART = MONSTER_SEPARATION_DISTANCE * 0.85;
const TARGET_ID = 1;

function monster(id: number, x: number, z: number, overrides: Partial<Monster> = {}): Monster {
  return {
    kind: 'monster',
    id,
    name: '行尸',
    x,
    z,
    path: null,
    pathIndex: 0,
    maxHp: 60,
    hp: 60,
    moving: false,
    dead: false,
    targetId: 0,
    nextAttackAt: 0,
    respawnAt: 0,
    homeX: x,
    homeZ: z,
    ai: 'idle',
    inWorld: true,
    nextThinkAt: 0,
    nextPathAt: 0,
    chaseX: x,
    chaseZ: z,
    hideAt: 0,
    ...overrides,
  };
}

/** 站在目标旁边打的怪物。 */
function standing(id: number, x: number, z: number): Monster {
  return monster(id, x, z, { ai: 'chase', targetId: TARGET_ID });
}

/** 正从 (x, z) 直线走向 to 的怪物。 */
function walking(id: number, x: number, z: number, to: Point): Monster {
  return monster(id, x, z, { ai: 'chase', targetId: TARGET_ID, moving: true, path: [{ x, z }, to], pathIndex: 1 });
}

function setup(blockedCells: [number, number][] = []) {
  const map = emptyMap(64);
  for (const [cx, cz] of blockedCells) map.blocked[cz * 64 + cx] = 1;
  const pathfinder = new Pathfinder(map);
  const target = { x: 30.5, z: 30.5, dead: false };
  const moved: Monster[] = [];
  const host: SeparationHost = {
    pathfinder,
    findPlayer: (id) => (id === TARGET_ID ? target : undefined),
    moved: (m) => void moved.push(m),
  };
  const separation = new MonsterSeparation();
  /** 推进 ticks 次，返回这期间一共挪动了多少次。 */
  const run = (monsters: Monster[], ticks: number): number => {
    moved.length = 0;
    for (let i = 0; i < ticks; i++) separation.update(monsters, host);
    return moved.length;
  };
  return { pathfinder, target, moved, run };
}

function between(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.z - b.z);
}

function closestPair(monsters: Point[]): number {
  let closest = Infinity;
  for (let i = 0; i < monsters.length; i++) {
    for (let j = i + 1; j < monsters.length; j++) closest = Math.min(closest, between(monsters[i], monsters[j]));
  }
  return closest;
}

describe('怪物的软分离：站在目标旁边的', () => {
  it('一前一后站在玩家同一侧的两只，绕着玩家往两边分开，离玩家的距离不变', () => {
    const { target, run } = setup();
    const a = standing(10, target.x + 1.15, target.z);
    const b = standing(11, target.x + 1.05, target.z);

    expect(run([a, b], 60)).toBeGreaterThan(0);
    expect(between(a, b)).toBeGreaterThanOrEqual(APART);
    expect(between(a, target)).toBeCloseTo(1.15, 6);
    expect(between(b, target)).toBeCloseTo(1.05, 6);
    // 一个往左、一个往右。
    expect((a.z - target.z) * (b.z - target.z)).toBeLessThan(0);
    // 分开之后就站住了。
    expect(run([a, b], 40)).toBe(0);
  });

  it('完全重合的两只也能分开', () => {
    const { target, run } = setup();
    const a = standing(10, target.x, target.z - 1.1);
    const b = standing(11, target.x, target.z - 1.1);
    run([a, b], 60);
    expect(between(a, b)).toBeGreaterThanOrEqual(APART);
    expect(between(a, target)).toBeCloseTo(1.1, 6);
    expect(between(b, target)).toBeCloseTo(1.1, 6);
  });

  it('挤了很多只时尽量散开，最后都站住，不会一直挤来挤去', () => {
    const { target, run } = setup();
    const monsters = Array.from({ length: 12 }, (_, i) => standing(10 + i, target.x + 1.03 + i * 0.014, target.z));
    const radii = monsters.map((m) => between(m, target));

    run(monsters, 300);
    // 一圈站不下 12 只，做不到都隔开 MONSTER_SEPARATION_DISTANCE，但不会再有叠在一起的。
    expect(closestPair(monsters)).toBeGreaterThan(0.3);
    monsters.forEach((m, i) => expect(between(m, target)).toBeCloseTo(radii[i], 6));
    expect(run(monsters, 100)).toBe(0);
  });

  it('不会被推到看不见目标的位置（墙后面）', () => {
    // 墙在目标的东南角。往南转的那只很快被墙挡住，另一只往北让开。
    const { pathfinder, target, run } = setup([[31, 31]]);
    const a = standing(10, target.x + 1.15, target.z);
    const b = standing(11, target.x + 1.05, target.z);
    for (let i = 0; i < 80; i++) {
      run([a, b], 1);
      for (const m of [a, b]) expect(pathfinder.lineOfSight(m.x, m.z, target.x, target.z)).toBe(true);
    }
    expect(between(a, b)).toBeGreaterThanOrEqual(APART);
    // 往南的那只（id 大的）没走出多远。
    expect(b.z).toBeGreaterThan(target.z);
    expect(b.z).toBeLessThan(31);
    expect(a.z).toBeLessThan(target.z - 0.4);
  });

  it('目标死了、离目标太远或者几乎站在目标身上时不动', () => {
    const { target, run } = setup();
    const far = [standing(10, target.x + 3, target.z), standing(11, target.x + 3, target.z + 0.2)];
    expect(run(far, 20)).toBe(0);
    const onTop = [standing(12, target.x + 0.1, target.z), standing(13, target.x + 0.1, target.z + 0.1)];
    expect(run(onTop, 20)).toBe(0);
    const near = [standing(14, target.x + 1.1, target.z), standing(15, target.x + 1.1, target.z + 0.2)];
    target.dead = true;
    expect(run(near, 20)).toBe(0);
  });
});

describe('怪物的软分离：正在走路的', () => {
  const to = { x: 40.5, z: 10.5 };

  it('并排走的两只往两边让开', () => {
    const { run } = setup();
    const a = walking(10, 10.5, 10.4, { x: 40.5, z: 10.4 });
    const b = walking(11, 10.5, 10.6, { x: 40.5, z: 10.6 });
    run([a, b], 60);
    expect(between(a, b)).toBeGreaterThanOrEqual(APART);
    expect(a.z).toBeLessThan(10.4);
    expect(b.z).toBeGreaterThan(10.6);
    // 只是横着挪，没有被往前或往后推。
    expect(a.x).toBeCloseTo(10.5, 6);
    expect(b.x).toBeCloseTo(10.5, 6);
  });

  it('走同一条路、完全重合的两只，一左一右让开', () => {
    const { run } = setup();
    const a = walking(10, 10.5, 10.5, to);
    const b = walking(11, 10.5, 10.5, to);
    run([a, b], 60);
    expect(between(a, b)).toBeGreaterThanOrEqual(APART);
    expect(a.z + b.z).toBeCloseTo(21, 6);
    expect(a.x).toBeCloseTo(10.5, 6);
  });

  it('一前一后时只把后面的往后推，前面的不会被推着走得更快', () => {
    const { run } = setup();
    const front = walking(10, 10.8, 10.5, to);
    const back = walking(11, 10.5, 10.5, to);
    expect(run([front, back], 1)).toBe(1);
    expect(front.x).toBe(10.8);
    expect(back.x).toBeLessThan(10.5);
    expect(back.x).toBeGreaterThanOrEqual(10.5 - MAX_STEP);
    expect(back.z).toBeCloseTo(10.5, 6);
  });

  it('闲着的怪物不会被推离出生位置，但路过的会绕开它；尸体和已经消失的不算', () => {
    const { run } = setup();
    const idle = monster(10, 10.5, 10.5);
    const passer = walking(11, 10.5, 10.8, { x: 40.5, z: 10.8 });
    expect(run([idle, passer], 30)).toBeGreaterThan(0);
    expect(idle).toMatchObject({ x: 10.5, z: 10.5 });
    expect(passer.z).toBeGreaterThanOrEqual(10.5 + APART);

    const corpse = monster(12, 20.5, 10.5, { dead: true });
    const gone = monster(13, 20.5, 10.5, { dead: true, inWorld: false });
    const other = walking(14, 20.5, 10.8, { x: 40.5, z: 10.8 });
    expect(run([corpse, gone, other], 30)).toBe(0);
  });

  it('不会被推进墙里，也不会被推到走不到下一个路径点的位置', () => {
    // 墙在路的南边。靠墙的那只挪不动多少，另一只往北让开。
    const { pathfinder, run } = setup([
      [10, 11],
      [11, 11],
      [12, 11],
    ]);
    const a = walking(10, 10.5, 10.3, { x: 40.5, z: 10.3 });
    const b = walking(11, 10.5, 10.6, { x: 40.5, z: 10.6 });
    for (let i = 0; i < 60; i++) {
      run([a, b], 1);
      expect(pathfinder.lineOfSight(b.x, b.z, 40.5, 10.6)).toBe(true);
    }
    expect(b.z).toBeLessThan(10.75);
    expect(between(a, b)).toBeGreaterThanOrEqual(APART);
  });
});

class FakeConn implements Connection {
  readonly messages: ServerMsg[] = [];
  send(msg: ServerMsg): void {
    this.messages.push(msg);
  }
  /** 取走到现在为止收到的 hit 消息里，打人的都是谁。 */
  takeAttackers(): Set<number> {
    const from = new Set<number>();
    for (const m of this.messages.splice(0)) if (m.t === 'hit') from.add(m.from);
    return from;
  }
  /** 最近一个快照里的实体。 */
  lastSnap(): SnapEntity[] {
    for (let i = this.messages.length - 1; i >= 0; i--) {
      const m = this.messages[i];
      if (m.t === 'snap') return m.entities;
    }
    return [];
  }
}

describe('怪物的软分离：在世界里', () => {
  function run(world: World, fromMs: number, ms: number, each?: () => void): number {
    let now = fromMs;
    for (let i = 0; i < Math.round(ms / TICK_MS); i++) {
      now += TICK_MS;
      world.tick(now);
      each?.();
    }
    return now;
  }

  it('从同一个方向追过来的两只，站定后分开，都还打得到玩家', () => {
    const world = new World(emptyMap(256));
    const a = world.spawnMonster(100.5, 100.5);
    const b = world.spawnMonster(98.5, 100.5);
    const conn = new FakeConn();
    const playerId = world.join('a', conn, 0, { x: 105.5, z: 100.5 });

    run(world, 0, 4000);
    const player = world.getPlayer(playerId)!;
    const ma = world.getMonster(a)!;
    const mb = world.getMonster(b)!;
    expect(between(ma, mb)).toBeGreaterThanOrEqual(APART);
    for (const m of [ma, mb]) {
      expect(m.moving).toBe(false);
      expect(between(m, player)).toBeLessThanOrEqual(MONSTER_STOP_DISTANCE);
    }

    // 之后两只都站着不动，轮流打玩家。
    conn.takeAttackers();
    const now = run(world, 4000, 2000);
    expect(conn.takeAttackers()).toEqual(new Set([a, b]));
    expect(world.getMonster(a)).toMatchObject({ x: ma.x, z: ma.z });
    expect(world.getMonster(b)).toMatchObject({ x: mb.x, z: mb.z });
    // 客户端从快照里看到的也是分开的位置。
    run(world, now, 100);
    const seen = conn.lastSnap().filter((e) => e[0] === a || e[0] === b);
    expect(seen).toHaveLength(2);
    expect(Math.hypot(seen[0][1] - seen[1][1], seen[0][2] - seen[1][2])).toBeGreaterThanOrEqual(APART - 0.02);
  });

  it('追着玩家跑的两只不会叠成一只，也不会因此跑得更快', () => {
    const world = new World(emptyMap(256));
    const a = world.spawnMonster(100.5, 100.5);
    const b = world.spawnMonster(100.5, 104.5);
    const playerId = world.join('a', new FakeConn(), 0, { x: 104.5, z: 100.5 });

    // 等两只都追到跟前，再沿直线跑开：它们会走到同一条路上。
    let now = run(world, 0, 2000);
    world.moveTo(playerId, 134.5, 100.5);
    now = run(world, now, 1000);

    let closest = Infinity;
    const start = [world.getMonster(a)!, world.getMonster(b)!];
    run(world, now, 3000, () => {
      closest = Math.min(closest, between(world.getMonster(a)!, world.getMonster(b)!));
    });
    const end = [world.getMonster(a)!, world.getMonster(b)!];
    expect(end.every((m) => m.ai === 'chase' && m.moving)).toBe(true);
    expect(closest).toBeGreaterThan(0.6);
    // 这 3 秒里朝玩家跑的方向（+x）走过的距离。横着让开时会带一点点 +x 的分量，所以留 2% 的余量；
    // 要是被往前推了，会多出几十个百分点。
    for (let i = 0; i < 2; i++) expect(end[i].x - start[i].x).toBeLessThanOrEqual(MONSTER_SPEED * 3 * 1.02);
  });

  it('贴着安全区打的怪物不会被推进安全区', () => {
    const world = new World(emptyMap(256));
    // 玩家站在安全区东边界外面半格的地方，两只怪物从正北沿着边界追过来。
    const a = world.spawnMonster(142.5, 123.5);
    const b = world.spawnMonster(142.5, 121.5);
    const conn = new FakeConn();
    const playerId = world.join('a', conn, 0, { x: 142.5, z: 128.5 });
    expect(world.inSafeZone(142.5, 128.5)).toBe(false);
    expect(world.inSafeZone(141.9, 127.5)).toBe(true);

    let entered = false;
    const now = run(world, 0, 4000, () => {
      for (const id of [a, b]) {
        const m = world.getMonster(id)!;
        if (world.inSafeZone(m.x, m.z)) entered = true;
      }
    });
    expect(entered).toBe(false);
    const player = world.getPlayer(playerId)!;
    const ma = world.getMonster(a)!;
    const mb = world.getMonster(b)!;
    expect(between(ma, mb)).toBeGreaterThanOrEqual(APART);
    for (const m of [ma, mb]) expect(between(m, player)).toBeLessThanOrEqual(MONSTER_STOP_DISTANCE);
    conn.takeAttackers();
    run(world, now, 2000);
    expect(conn.takeAttackers()).toEqual(new Set([a, b]));
  });
});
