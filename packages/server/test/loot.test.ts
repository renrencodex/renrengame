import { describe, expect, it } from 'vitest';
import {
  DROP_LIFETIME_MS,
  DROP_PICKUP_DELAY_MS,
  emptyMap,
  GOLD_DROP_MAX,
  GOLD_DROP_MIN,
  ITEMS,
  PICKUP_RADIUS,
  PLAYER_MAX_HP,
  PLAYER_RESPAWN_MS,
  POTION_COOLDOWN_MS,
  POTION_HEAL,
  SWORD_DROP_CHANCE,
  TICK_MS,
} from '@mmo/shared';
import type { DropInfo, ServerMsg } from '@mmo/shared';
import { World } from '../src/world';
import type { Connection } from '../src/world';

class FakeConn implements Connection {
  readonly messages: ServerMsg[] = [];
  send(msg: ServerMsg): void {
    this.messages.push(msg);
  }
  take(): ServerMsg[] {
    return this.messages.splice(0);
  }
}

/** 带时钟的世界，方便按 tick 或按毫秒推进。 */
class Sim {
  now = 0;
  constructor(readonly world: World) {}

  tick(n = 1): void {
    for (let i = 0; i < n; i++) {
      this.now += TICK_MS;
      this.world.tick(this.now);
    }
  }

  runMs(ms: number): void {
    this.tick(Math.round(ms / TICK_MS));
  }

  runUntil(condition: () => boolean, maxMs: number): boolean {
    const deadline = this.now + maxMs;
    while (this.now < deadline) {
      if (condition()) return true;
      this.tick();
    }
    return condition();
  }
}

/** 依次返回给定的值，用完之后一直返回最后一个。 */
function sequence(...values: number[]): () => number {
  let i = 0;
  return () => values[Math.min(i++, values.length - 1)];
}

function enteredDrops(msgs: ServerMsg[]): DropInfo[] {
  return msgs.flatMap((m) => (m.t === 'enter' ? m.entities.filter((e) => e.kind === 'drop') : []));
}

function leftIds(msgs: ServerMsg[]): number[] {
  return msgs.flatMap((m) => (m.t === 'leave' ? m.ids : []));
}

function inventories(msgs: ServerMsg[]): Extract<ServerMsg, { t: 'inv' }>['items'][] {
  return msgs.flatMap((m) => (m.t === 'inv' ? [m.items] : []));
}

function snapIds(msgs: ServerMsg[]): number[] {
  return msgs.flatMap((m) => (m.t === 'snap' ? m.entities.map((e) => e[0]) : []));
}

// 这些测试都放在离地图中心的安全区很远的地方。

describe('怪物掉落', () => {
  /** 玩家站在怪物东边一个单位的地方把它打死。怪物贴着玩家，不会移动。 */
  function killMonster(lootRandom: () => number, blockedCells: [number, number][] = []) {
    const map = emptyMap(256);
    for (const [cx, cz] of blockedCells) map.blocked[cz * 256 + cx] = 1;
    const world = new World(map, lootRandom);
    const sim = new Sim(world);
    const monsterId = world.spawnMonster(100.5, 100.5);
    const conn = new FakeConn();
    const playerId = world.join('a', conn, 0, { x: 101.5, z: 100.5 });
    world.setTarget(playerId, monsterId);
    expect(sim.runUntil(() => world.getMonster(monsterId)!.dead, 10000)).toBe(true);
    return { world, sim, monsterId, playerId, conn };
  }

  it('怪物死后在尸体旁边掉一堆金币，看得到的玩家收到 enter', () => {
    // 依次是：金币数量、方向、距离、是否掉药水、是否掉剑（序列用完后一直是最后一个数）。
    // 方向 0.5 是正西，玩家在东边够不着。
    const { world, sim, conn } = killMonster(sequence(0.999, 0.5, 0.5, 0.9));
    const drops = enteredDrops(conn.take());
    expect(drops).toEqual([{ id: expect.any(Number), kind: 'drop', x: 99.65, z: 100.5, item: 'gold', count: GOLD_DROP_MAX }]);
    expect(world.dropCount).toBe(1);
    expect(world.stats.dropped).toBe(1);

    // 地上的物品不出现在快照里。
    sim.tick(4);
    const msgs = conn.take();
    expect(snapIds(msgs).length).toBeGreaterThan(0);
    expect(snapIds(msgs)).not.toContain(drops[0].id);
  });

  it('金币数量在上下限之间', () => {
    const least = killMonster(sequence(0, 0.5, 0.5, 0.9));
    expect(enteredDrops(least.conn.take())[0].count).toBe(GOLD_DROP_MIN);
    const most = killMonster(sequence(0.999999, 0.5, 0.5, 0.9));
    expect(enteredDrops(most.conn.take())[0].count).toBe(GOLD_DROP_MAX);
  });

  it('运气好时还会掉一瓶药水，落在尸体的另一侧', () => {
    const { world, conn } = killMonster(sequence(0, 0.5, 0.5, 0.1, 0.5));
    const drops = enteredDrops(conn.take());
    expect(drops).toEqual([
      { id: expect.any(Number), kind: 'drop', x: 99.65, z: 100.5, item: 'gold', count: GOLD_DROP_MIN },
      { id: expect.any(Number), kind: 'drop', x: 101.35, z: 100.5, item: 'potion', count: 1 },
    ]);
    expect(world.dropCount).toBe(2);
  });

  it('运气很好时掉一把剑，落在和金币、药水都不同的方向上', () => {
    // 依次是：金币数量、方向、金币的距离、是否掉药水、药水的距离、是否掉剑、剑的距离。
    const { world, conn } = killMonster(sequence(0, 0.5, 0.5, 0.1, 0.5, SWORD_DROP_CHANCE - 0.001, 0.5));
    expect(enteredDrops(conn.take())).toEqual([
      { id: expect.any(Number), kind: 'drop', x: 99.65, z: 100.5, item: 'gold', count: GOLD_DROP_MIN },
      { id: expect.any(Number), kind: 'drop', x: 101.35, z: 100.5, item: 'potion', count: 1 },
      { id: expect.any(Number), kind: 'drop', x: 100.5, z: 99.65, item: 'sword', count: 1 },
    ]);
    expect(world.dropCount).toBe(3);
  });

  it('掉不掉剑和掉不掉药水互不影响；刚好等于概率时不掉', () => {
    const swordOnly = killMonster(sequence(0, 0.5, 0.5, 0.9, 0, 0.5));
    expect(enteredDrops(swordOnly.conn.take()).map((d) => d.item)).toEqual(['gold', 'sword']);
    const unlucky = killMonster(sequence(0, 0.5, 0.5, 0.9, SWORD_DROP_CHANCE));
    expect(enteredDrops(unlucky.conn.take()).map((d) => d.item)).toEqual(['gold']);
  });

  it('本来要落在墙里时，改成落在尸体的位置', () => {
    // 怪物西边的格子 (99, 100) 是墙。
    const { conn } = killMonster(sequence(0, 0.5, 0.5, 0.9), [[99, 100]]);
    expect(enteredDrops(conn.take())).toEqual([
      { id: expect.any(Number), kind: 'drop', x: 100.5, z: 100.5, item: 'gold', count: GOLD_DROP_MIN },
    ]);
  });

  it('怪物重生后再被打死，会再掉一次', () => {
    // 每次死亡用掉五个数：金币数量、方向、距离、是否掉药水、是否掉剑。
    const { world, sim, monsterId, playerId } = killMonster(sequence(0, 0.5, 0.5, 0.9, 0.9, 0, 0.5, 0.5, 0.9, 0.9));
    expect(sim.runUntil(() => !world.getMonster(monsterId)!.dead, 30000)).toBe(true);
    world.setTarget(playerId, monsterId);
    expect(sim.runUntil(() => world.getMonster(monsterId)!.dead, 10000)).toBe(true);
    expect(world.stats.dropped).toBe(2);
    expect(world.dropCount).toBe(2);
  });
});

describe('拾取', () => {
  function setup(blockedCells: [number, number][] = []) {
    const map = emptyMap(256);
    for (const [cx, cz] of blockedCells) map.blocked[cz * 256 + cx] = 1;
    const world = new World(map);
    return { world, sim: new Sim(world) };
  }

  it('走到物品旁边自动捡起：背包增加，物品从所有人的视野里消失', () => {
    const { world, sim } = setup();
    const a = new FakeConn();
    const b = new FakeConn();
    const idA = world.join('a', a, 0, { x: 45.5, z: 40.5 });
    world.join('b', b, 0, { x: 60.5, z: 40.5 });
    const dropId = world.spawnDrop('gold', 5, 50.5, 40.5, sim.now);
    expect(enteredDrops(a.take())).toEqual([{ id: dropId, kind: 'drop', x: 50.5, z: 40.5, item: 'gold', count: 5 }]);
    expect(enteredDrops(b.take()).map((d) => d.id)).toEqual([dropId]);

    // 离得远时捡不到。
    sim.runMs(1000);
    expect(world.dropCount).toBe(1);

    world.moveTo(idA, 50.5, 40.5);
    expect(sim.runUntil(() => world.dropCount === 0, 3000)).toBe(true);
    // 进入拾取半径的那个 tick 就捡起来了，不用走到正上方。
    const p = world.getPlayer(idA)!;
    expect(50.5 - p.x).toBeLessThanOrEqual(PICKUP_RADIUS);
    expect(50.5 - p.x).toBeGreaterThan(PICKUP_RADIUS - 0.5);
    expect(p.items).toEqual({ gold: 5 });
    expect(world.stats.pickedUp).toBe(1);

    const msgsA = a.take();
    expect(leftIds(msgsA)).toEqual([dropId]);
    expect(inventories(msgsA)).toEqual([{ gold: 5 }]);
    const msgsB = b.take();
    expect(leftIds(msgsB)).toEqual([dropId]);
    expect(inventories(msgsB)).toEqual([]);
  });

  it('同一种物品的数量累加', () => {
    const { world, sim } = setup();
    const conn = new FakeConn();
    const id = world.join('a', conn, 0, { x: 40.5, z: 40.5 }, undefined, { gold: 10 });
    world.spawnDrop('gold', 5, 40.5, 40.5, sim.now);
    world.spawnDrop('gold', 2, 41, 40.5, sim.now);
    world.spawnDrop('potion', 1, 40.5, 41, sim.now);
    sim.runMs(DROP_PICKUP_DELAY_MS);
    expect(world.getPlayer(id)!.items).toEqual({ gold: 17, potion: 1 });
    // 同一个 tick 捡起的几样东西只发一次背包。
    expect(inventories(conn.take())).toEqual([{ gold: 10 }, { gold: 17, potion: 1 }]);
  });

  it('刚掉下来的物品要等一小会儿才能捡', () => {
    const { world, sim } = setup();
    const id = world.join('a', new FakeConn(), 0, { x: 40.5, z: 40.5 });
    world.spawnDrop('gold', 5, 40.5, 40.5, sim.now);
    sim.runMs(DROP_PICKUP_DELAY_MS - TICK_MS);
    expect(world.getPlayer(id)!.items).toEqual({});
    sim.tick();
    expect(world.getPlayer(id)!.items).toEqual({ gold: 5 });
  });

  it('两个人抢同一堆，先到的拿走，后到的什么也没有', () => {
    const { world, sim } = setup();
    const idA = world.join('a', new FakeConn(), 0, { x: 47.5, z: 40.5 });
    const idB = world.join('b', new FakeConn(), 0, { x: 56.5, z: 40.5 });
    world.spawnDrop('gold', 5, 50.5, 40.5, sim.now);
    world.moveTo(idA, 50.5, 40.5);
    world.moveTo(idB, 50.5, 40.5);
    sim.runMs(3000);
    expect(world.getPlayer(idA)!.items).toEqual({ gold: 5 });
    expect(world.getPlayer(idB)!.items).toEqual({});
    expect(world.stats.pickedUp).toBe(1);
  });

  it('隔着墙捡不到', () => {
    // 格子 (50, 40) 是墙，玩家和物品分别贴在它的两边，直线距离 1.15。
    const { world, sim } = setup([[50, 40]]);
    const id = world.join('a', new FakeConn(), 0, { x: 49.9, z: 40.5 });
    world.spawnDrop('gold', 5, 51.05, 40.5, sim.now);
    sim.runMs(2000);
    expect(world.getPlayer(id)!.items).toEqual({});
    expect(world.dropCount).toBe(1);
  });

  it('这种物品带满了就留在地上，用掉一个之后才捡得起来', () => {
    const { world, sim } = setup();
    const max = ITEMS.potion.maxCount;
    const conn = new FakeConn();
    const id = world.join('a', conn, 0, { x: 40.5, z: 40.5 }, 50, { potion: max });
    world.spawnDrop('potion', 1, 40.5, 40.5, sim.now);
    sim.runMs(POTION_COOLDOWN_MS);
    expect(world.dropCount).toBe(1);
    expect(world.getPlayer(id)!.items).toEqual({ potion: max });

    expect(world.useItem(id, 'potion', sim.now)).toBe(true);
    expect(world.getPlayer(id)!.items).toEqual({ potion: max - 1 });
    sim.tick();
    expect(world.dropCount).toBe(0);
    expect(world.getPlayer(id)!.items).toEqual({ potion: max });
  });

  it('死了的玩家捡不了东西；复活之后背包还在', () => {
    const { world, sim } = setup();
    for (const [x, z] of [
      [41.5, 40.5],
      [39.5, 40.5],
      [40.5, 41.5],
      [40.5, 39.5],
    ]) {
      world.spawnMonster(x, z);
    }
    const id = world.join('a', new FakeConn(), 0, { x: 40.5, z: 40.5 }, undefined, { gold: 7 });
    expect(sim.runUntil(() => world.getPlayer(id)!.dead, 20000)).toBe(true);

    world.spawnDrop('gold', 5, 40.5, 40.5, sim.now);
    sim.runMs(PLAYER_RESPAWN_MS - TICK_MS);
    expect(world.getPlayer(id)).toMatchObject({ dead: true, items: { gold: 7 } });
    expect(world.dropCount).toBe(1);

    sim.tick();
    expect(world.getPlayer(id)).toMatchObject({ dead: false, items: { gold: 7 } });
  });

  it('没人捡的物品过一段时间自己消失，看得到的玩家收到 leave', () => {
    const { world, sim } = setup();
    const conn = new FakeConn();
    world.join('a', conn, 0, { x: 40.5, z: 40.5 });
    const first = world.spawnDrop('gold', 5, 50.5, 40.5, sim.now);
    sim.runMs(1000);
    const second = world.spawnDrop('potion', 1, 52.5, 40.5, sim.now);
    conn.take();

    sim.runMs(DROP_LIFETIME_MS - 1000 - TICK_MS);
    expect(world.dropCount).toBe(2);
    sim.tick();
    expect(world.dropCount).toBe(1);
    expect(leftIds(conn.take())).toEqual([first]);

    sim.runMs(1000);
    expect(world.dropCount).toBe(0);
    expect(leftIds(conn.take())).toEqual([second]);
    expect(world.stats.pickedUp).toBe(0);
  });

  it('物品和别的实体一样按视野下发：上线时看到附近的，走近时出现，走远时消失', () => {
    const { world, sim } = setup();
    // 物品在格子 x = 3（96–128）。
    const dropId = world.spawnDrop('gold', 5, 97.5, 40.5, sim.now);
    const near = new FakeConn();
    world.join('near', near, 0, { x: 90.5, z: 40.5 });
    expect(enteredDrops(near.take()).map((d) => d.id)).toEqual([dropId]);

    // 另一个玩家在格子 x = 1，一开始看不到；走到格子 x = 2 时看到，走回去又看不到。
    const far = new FakeConn();
    const farId = world.join('far', far, 0, { x: 60.5, z: 40.5 });
    expect(enteredDrops(far.take())).toEqual([]);
    world.moveTo(farId, 66.5, 40.5);
    sim.runMs(2000);
    expect(enteredDrops(far.take())).toEqual([{ id: dropId, kind: 'drop', x: 97.5, z: 40.5, item: 'gold', count: 5 }]);
    world.moveTo(farId, 60.5, 40.5);
    sim.runMs(2000);
    expect(leftIds(far.take())).toContain(dropId);
  });
});

describe('背包和药水', () => {
  function setup() {
    const world = new World(emptyMap(256));
    return { world, sim: new Sim(world) };
  }

  it('带着存档的背包进入世界，一上线就收到背包内容', () => {
    const { world } = setup();
    const conn = new FakeConn();
    const saved = { gold: 12, potion: 2 };
    const id = world.join('a', conn, 0, { x: 40.5, z: 40.5 }, undefined, saved);
    expect(conn.take().slice(0, 2)).toEqual([
      { t: 'welcome', selfId: id, seed: 0, serverTime: 0 },
      { t: 'inv', items: { gold: 12, potion: 2 }, weapon: null },
    ]);

    // 拿到的是拷贝，改它不影响世界里的背包；世界也不会改传进去的存档。
    const state = world.getPlayer(id)!;
    state.items.gold = 999;
    expect(world.getPlayer(id)!.items).toEqual({ gold: 12, potion: 2 });
    world.spawnDrop('gold', 1, 40.5, 40.5, 0);
    world.tick(DROP_PICKUP_DELAY_MS);
    expect(world.getPlayer(id)!.items).toEqual({ gold: 13, potion: 2 });
    expect(saved).toEqual({ gold: 12, potion: 2 });
  });

  it('存档里不合法的物品和数量会被去掉', () => {
    const { world } = setup();
    const id = world.join('a', new FakeConn(), 0, { x: 40.5, z: 40.5 }, undefined, {
      gold: 3.7,
      potion: 9999,
      wand: 1,
    } as never);
    expect(world.getPlayer(id)!.items).toEqual({ gold: 3, potion: ITEMS.potion.maxCount });
  });

  it('喝药水回血：消耗一瓶，周围的人都看到回血，之后进入冷却', () => {
    const { world, sim } = setup();
    const a = new FakeConn();
    const b = new FakeConn();
    const id = world.join('a', a, 0, { x: 40.5, z: 40.5 }, 30, { potion: 3 });
    world.join('b', b, 0, { x: 45.5, z: 40.5 });
    sim.runMs(POTION_COOLDOWN_MS);
    a.take();
    b.take();

    expect(world.useItem(id, 'potion', sim.now)).toBe(true);
    expect(world.getPlayer(id)).toMatchObject({ hp: 30 + POTION_HEAL, items: { potion: 2 } });
    const heal: ServerMsg = { t: 'heal', id, amount: POTION_HEAL };
    expect(a.take()).toEqual([{ t: 'inv', items: { potion: 2 }, weapon: null }, heal]);
    expect(b.take()).toEqual([heal]);

    // 冷却期间喝不了，也不消耗药水。
    sim.runMs(POTION_COOLDOWN_MS - TICK_MS);
    expect(world.useItem(id, 'potion', sim.now)).toBe(false);
    expect(world.getPlayer(id)!.items).toEqual({ potion: 2 });
    sim.tick();

    // 回血不会超过上限，飘字的数字是实际回的量。
    const before = world.getPlayer(id)!.hp;
    expect(before).toBeGreaterThan(PLAYER_MAX_HP - POTION_HEAL);
    expect(before).toBeLessThan(PLAYER_MAX_HP);
    expect(world.useItem(id, 'potion', sim.now)).toBe(true);
    expect(world.getPlayer(id)).toMatchObject({ hp: PLAYER_MAX_HP, items: { potion: 1 } });
    expect(a.take()).toContainEqual({ t: 'heal', id, amount: PLAYER_MAX_HP - before });
  });

  it('刚上线要先等一轮冷却，不能靠重新登录连着喝', () => {
    const { world, sim } = setup();
    const id = world.join('a', new FakeConn(), 0, { x: 40.5, z: 40.5 }, 30, { potion: 3 });
    sim.runMs(POTION_COOLDOWN_MS - TICK_MS);
    expect(world.useItem(id, 'potion', sim.now)).toBe(false);
    sim.tick();
    expect(world.useItem(id, 'potion', sim.now)).toBe(true);
  });

  it('满血、没有药水、已经死亡时都喝不了；金币不能使用', () => {
    const { world, sim } = setup();
    const full = world.join('full', new FakeConn(), 0, { x: 40.5, z: 40.5 }, undefined, { potion: 1 });
    const empty = world.join('empty', new FakeConn(), 0, { x: 40.5, z: 40.5 }, 30);
    const rich = world.join('rich', new FakeConn(), 0, { x: 40.5, z: 40.5 }, 30, { gold: 100 });
    sim.runMs(POTION_COOLDOWN_MS);

    expect(world.useItem(full, 'potion', sim.now)).toBe(false);
    expect(world.getPlayer(full)!.items).toEqual({ potion: 1 });
    expect(world.useItem(empty, 'potion', sim.now)).toBe(false);
    expect(world.useItem(rich, 'gold', sim.now)).toBe(false);
    expect(world.getPlayer(rich)).toMatchObject({ hp: 30, items: { gold: 100 } });
    expect(world.useItem(9999, 'potion', sim.now)).toBe(false);
  });

  it('死了之后不能喝药水', () => {
    const { world, sim } = setup();
    for (const [x, z] of [
      [41.5, 40.5],
      [39.5, 40.5],
      [40.5, 41.5],
      [40.5, 39.5],
    ]) {
      world.spawnMonster(x, z);
    }
    const id = world.join('a', new FakeConn(), 0, { x: 40.5, z: 40.5 }, undefined, { potion: 2 });
    expect(sim.runUntil(() => world.getPlayer(id)!.dead, 20000)).toBe(true);
    // 把时间往后拨，排除“只是因为还在冷却”这种可能。
    expect(world.useItem(id, 'potion', sim.now + POTION_COOLDOWN_MS)).toBe(false);
    expect(world.getPlayer(id)).toMatchObject({ hp: 0, dead: true, items: { potion: 2 } });
  });
});
