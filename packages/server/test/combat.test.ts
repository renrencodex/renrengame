import { describe, expect, it } from 'vitest';
import {
  ATTACK_RANGE,
  emptyMap,
  generateMap,
  isWalkable,
  MAX_MONSTER_PATHFINDS_PER_TICK,
  MONSTER_ATTACK_DAMAGE,
  MONSTER_CORPSE_MS,
  MONSTER_MAX_HP,
  MONSTER_RESPAWN_MS,
  PLAYER_ATTACK_DAMAGE,
  PLAYER_ATTACK_INTERVAL_MS,
  PLAYER_MAX_HP,
  PLAYER_RESPAWN_MS,
  REGEN_DELAY_MS,
  SAFE_ZONE_RADIUS,
  SPAWN_RADIUS,
  STATE_DEAD,
  TICK_MS,
} from '@mmo/shared';
import type { EntityInfo, ServerMsg, SnapEntity } from '@mmo/shared';
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
  hits(): Extract<ServerMsg, { t: 'hit' }>[] {
    return this.messages.filter((m) => m.t === 'hit');
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

  /** 一直推进到条件成立，最多推进 maxMs。返回条件是否成立。 */
  runUntil(condition: () => boolean, maxMs: number): boolean {
    const deadline = this.now + maxMs;
    while (this.now < deadline) {
      if (condition()) return true;
      this.tick();
    }
    return condition();
  }
}

function enteredInfos(msgs: ServerMsg[]): EntityInfo[] {
  return msgs.flatMap((m) => (m.t === 'enter' ? m.entities : []));
}

function leftIds(msgs: ServerMsg[]): number[] {
  return msgs.flatMap((m) => (m.t === 'leave' ? m.ids : []));
}

function lastSnapOf(msgs: ServerMsg[], id: number): SnapEntity | undefined {
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i];
    if (m.t === 'snap') return m.entities.find((e) => e[0] === id);
  }
  return undefined;
}

// 这些测试都放在 (40, 40) 或 (100, 100) 附近，离地图中心的安全区很远。

describe('玩家攻击', () => {
  function setup(playerX: number, playerZ = 100.5, blockedCells: [number, number][] = []) {
    const map = emptyMap(256);
    for (const [cx, cz] of blockedCells) map.blocked[cz * 256 + cx] = 1;
    const world = new World(map);
    const sim = new Sim(world);
    const monsterId = world.spawnMonster(100.5, 100.5);
    const conn = new FakeConn();
    const playerId = world.join('a', conn, 0, { x: playerX, z: playerZ });
    return { map, world, sim, monsterId, playerId, conn };
  }

  it('站在怪物旁边并选中它，就会按固定间隔造成伤害', () => {
    const { world, sim, monsterId, playerId, conn } = setup(101.5);
    expect(world.setTarget(playerId, monsterId)).toBe(true);

    sim.tick();
    expect(world.getMonster(monsterId)!.hp).toBe(MONSTER_MAX_HP - PLAYER_ATTACK_DAMAGE);
    expect(conn.hits()).toContainEqual({ t: 'hit', from: playerId, to: monsterId, damage: PLAYER_ATTACK_DAMAGE });

    // 冷却期间不会再打。
    sim.runMs(PLAYER_ATTACK_INTERVAL_MS - TICK_MS);
    expect(world.getMonster(monsterId)!.hp).toBe(MONSTER_MAX_HP - PLAYER_ATTACK_DAMAGE);
    sim.tick();
    expect(world.getMonster(monsterId)!.hp).toBe(MONSTER_MAX_HP - PLAYER_ATTACK_DAMAGE * 2);
  });

  it('没有选中目标时不会攻击', () => {
    const { world, sim, monsterId } = setup(101.5);
    sim.runMs(2000);
    expect(world.getMonster(monsterId)!.hp).toBe(MONSTER_MAX_HP);
  });

  it('距离超过攻击范围时打不到', () => {
    const { world, sim, monsterId, playerId } = setup(100.5 + ATTACK_RANGE + 1.5);
    world.setTarget(playerId, monsterId);
    sim.tick();
    expect(world.getMonster(monsterId)!.hp).toBe(MONSTER_MAX_HP);
  });

  it('隔着墙打不到', () => {
    // 怪物和玩家之间的格子 (101, 100) 是墙，直线距离 1.7。
    const { world, sim, monsterId, playerId } = setup(102.2, 100.5, [[101, 100]]);
    world.setTarget(playerId, monsterId);
    sim.tick();
    expect(world.getMonster(monsterId)!.hp).toBe(MONSTER_MAX_HP);
    // 怪物也不能隔着墙打人。
    expect(world.getPlayer(playerId)!.hp).toBe(PLAYER_MAX_HP);
  });

  it('移动中不能攻击，站定之后才打', () => {
    const { world, sim, monsterId, playerId } = setup(101.5);
    world.setTarget(playerId, monsterId);
    world.moveTo(playerId, 101.9, 100.5); // 0.4 个单位，要走两个 tick
    sim.tick();
    expect(world.getPlayer(playerId)!.moving).toBe(true);
    expect(world.getMonster(monsterId)!.hp).toBe(MONSTER_MAX_HP);
    sim.tick();
    expect(world.getPlayer(playerId)!.moving).toBe(false);
    expect(world.getMonster(monsterId)!.hp).toBe(MONSTER_MAX_HP - PLAYER_ATTACK_DAMAGE);
  });

  it('目标只能是场上活着的怪物', () => {
    const { world, sim, monsterId, playerId } = setup(101.5);
    const otherPlayer = world.join('b', new FakeConn(), 0, { x: 102.5, z: 100.5 });
    expect(world.setTarget(playerId, 9999)).toBe(false);
    expect(world.setTarget(playerId, otherPlayer)).toBe(false);
    expect(world.setTarget(playerId, playerId)).toBe(false);
    expect(world.setTarget(9999, monsterId)).toBe(false);
    expect(world.setTarget(playerId, 0)).toBe(true);
    sim.runMs(1000);
    expect(world.getMonster(monsterId)!.hp).toBe(MONSTER_MAX_HP);
    expect(world.getPlayer(otherPlayer)!.hp).toBeLessThanOrEqual(PLAYER_MAX_HP);
  });

  it('取消目标后停止攻击', () => {
    const { world, sim, monsterId, playerId } = setup(101.5);
    world.setTarget(playerId, monsterId);
    sim.tick();
    world.setTarget(playerId, 0);
    sim.runMs(3000);
    expect(world.getMonster(monsterId)!.hp).toBe(MONSTER_MAX_HP - PLAYER_ATTACK_DAMAGE);
  });

  it('怪物被打死后尸体保留一会儿再消失，之后在原地满血重生', () => {
    const { world, sim, monsterId, playerId, conn } = setup(101.5);
    world.setTarget(playerId, monsterId);
    expect(sim.runUntil(() => world.getMonster(monsterId)!.dead, 10000)).toBe(true);
    const diedAt = sim.now;
    expect(world.getMonster(monsterId)).toMatchObject({ hp: 0, dead: true, inWorld: true });
    expect(world.monsterCount).toBe(0);

    // 尸体还在场上，快照里是死亡状态。
    conn.take();
    sim.tick(2);
    expect(lastSnapOf(conn.take(), monsterId)).toEqual([monsterId, 100.5, 100.5, STATE_DEAD, 0]);
    // 死了的怪物不能再被选中，也不会再挨打。
    expect(world.setTarget(playerId, monsterId)).toBe(false);

    sim.runMs(MONSTER_CORPSE_MS);
    expect(world.getMonster(monsterId)!.inWorld).toBe(false);
    const afterCorpse = conn.take();
    expect(leftIds(afterCorpse)).toEqual([monsterId]);
    expect(lastSnapOf(afterCorpse, monsterId)).toBeUndefined();

    sim.runMs(MONSTER_RESPAWN_MS - (sim.now - diedAt));
    expect(world.getMonster(monsterId)).toMatchObject({ x: 100.5, z: 100.5, hp: MONSTER_MAX_HP, dead: false, inWorld: true });
    expect(world.monsterCount).toBe(1);
    const respawned = enteredInfos(conn.take()).find((e) => e.id === monsterId);
    expect(respawned).toMatchObject({ kind: 'monster', hp: MONSTER_MAX_HP, maxHp: MONSTER_MAX_HP, state: 0 });
  });
});

describe('怪物 AI', () => {
  it('玩家靠近时追上来攻击', () => {
    const world = new World(emptyMap(256));
    const sim = new Sim(world);
    const monsterId = world.spawnMonster(100.5, 100.5);
    const conn = new FakeConn();
    const playerId = world.join('a', conn, 0, { x: 106.5, z: 100.5 }); // 距离 6，在仇恨范围内

    sim.tick(2);
    expect(world.getMonster(monsterId)).toMatchObject({ ai: 'chase', moving: true });

    expect(sim.runUntil(() => world.getPlayer(playerId)!.hp < PLAYER_MAX_HP, 5000)).toBe(true);
    expect(world.getPlayer(playerId)!.hp).toBe(PLAYER_MAX_HP - MONSTER_ATTACK_DAMAGE);
    expect(conn.hits()).toContainEqual({ t: 'hit', from: monsterId, to: playerId, damage: MONSTER_ATTACK_DAMAGE });
    // 追到跟前就站住，不会走到玩家身上。
    sim.runMs(1000);
    const m = world.getMonster(monsterId)!;
    expect(m.moving).toBe(false);
    expect(Math.hypot(m.x - 106.5, m.z - 100.5)).toBeGreaterThan(0.5);
    expect(Math.hypot(m.x - 106.5, m.z - 100.5)).toBeLessThanOrEqual(ATTACK_RANGE);
  });

  it('玩家在仇恨范围外时不动', () => {
    const world = new World(emptyMap(256));
    const sim = new Sim(world);
    const monsterId = world.spawnMonster(100.5, 100.5);
    const playerId = world.join('a', new FakeConn(), 0, { x: 110.5, z: 100.5 }); // 距离 10
    sim.runMs(3000);
    expect(world.getMonster(monsterId)).toMatchObject({ ai: 'idle', x: 100.5, z: 100.5 });
    expect(world.getPlayer(playerId)!.hp).toBe(PLAYER_MAX_HP);
    expect(world.monsterPathfinds).toBe(0);
  });

  it('目标跑远后放弃追击，回满血走回出生位置；回家途中不受伤害', () => {
    const world = new World(emptyMap(256));
    const sim = new Sim(world);
    const monsterId = world.spawnMonster(100.5, 100.5);
    const playerId = world.join('a', new FakeConn(), 0, { x: 101.5, z: 100.5 });

    // 先打一下，再跑开 40 个单位。
    world.setTarget(playerId, monsterId);
    sim.tick();
    expect(world.getMonster(monsterId)!.hp).toBe(MONSTER_MAX_HP - PLAYER_ATTACK_DAMAGE);
    world.setTarget(playerId, 0);
    world.moveTo(playerId, 141.5, 100.5);

    expect(sim.runUntil(() => world.getMonster(monsterId)!.ai === 'return', 15000)).toBe(true);
    const leftHome = world.getMonster(monsterId)!;
    expect(leftHome.hp).toBe(MONSTER_MAX_HP);
    expect(leftHome.x).toBeGreaterThan(105);

    // 玩家追回来打它：怪物到家之前打不掉血。
    sim.runUntil(() => !world.getPlayer(playerId)!.moving, 15000);
    world.setTarget(playerId, monsterId);
    world.moveTo(playerId, 101.5, 100.5);
    let damagedWhileReturning = false;
    const hitAfterHome = sim.runUntil(() => {
      const m = world.getMonster(monsterId)!;
      if (m.ai === 'return' && m.hp < MONSTER_MAX_HP) damagedWhileReturning = true;
      return m.ai !== 'return' && m.hp < MONSTER_MAX_HP;
    }, 30000);
    expect(damagedWhileReturning).toBe(false);
    expect(hitAfterHome).toBe(true);
  });

  it('不追进安全区，也不攻击安全区里的玩家', () => {
    const world = new World(emptyMap(256));
    const sim = new Sim(world);
    const edge = 128 + SAFE_ZONE_RADIUS;
    const monsterId = world.spawnMonster(edge + 3.5, 128.5);
    const playerId = world.join('a', new FakeConn(), 0, { x: edge - 1, z: 128.5 }); // 安全区里，离怪物 4.5

    sim.runMs(2000);
    expect(world.getMonster(monsterId)).toMatchObject({ ai: 'idle', moving: false });

    // 走出安全区：被发现。
    world.moveTo(playerId, edge + 1, 128.5);
    expect(sim.runUntil(() => world.getMonster(monsterId)!.ai === 'chase', 3000)).toBe(true);

    // 逃回安全区深处：怪物放弃，全程没有踏进安全区。
    world.moveTo(playerId, 128.5, 128.5);
    let enteredSafeZone = false;
    const gaveUp = sim.runUntil(() => {
      const m = world.getMonster(monsterId)!;
      if (Math.hypot(m.x - 128, m.z - 128) < SAFE_ZONE_RADIUS - 0.2) enteredSafeZone = true;
      return m.ai === 'idle';
    }, 20000);
    expect(gaveUp).toBe(true);
    expect(enteredSafeZone).toBe(false);
    const hpInSafeZone = world.getPlayer(playerId)!.hp;
    sim.runMs(3000);
    expect(world.getPlayer(playerId)!.hp).toBeGreaterThanOrEqual(hpInSafeZone);
  });

  it('脱战回家时绕开安全区，即使直线回家会穿过它', () => {
    const world = new World(emptyMap(256));
    const sim = new Sim(world);
    const home = { x: 128.5, z: 112.5 }; // 安全区正北，紧挨着边界
    const monsterId = world.spawnMonster(home.x, home.z);
    const playerId = world.join('a', new FakeConn(), 0, { x: 131.5, z: 113.5 });
    const distanceToCenter = (p: { x: number; z: number }) => Math.hypot(p.x - 128, p.z - 128);
    let closest = Infinity;
    const track = () => {
      closest = Math.min(closest, distanceToCenter(world.getMonster(monsterId)!));
      return false;
    };

    // 玩家沿着安全区外面（离中心 17 个单位）顺时针绕，把怪物带到安全区的东侧。
    const waypoints = [30, 60, 90, 110].map((degrees) => {
      const a = (degrees * Math.PI) / 180;
      return { x: 128 + 17 * Math.sin(a), z: 128 - 17 * Math.cos(a) };
    });
    for (const to of waypoints) {
      world.moveTo(playerId, to.x, to.z);
      // 等怪物跟上来再走下一段，不然它会因为目标太远而放弃。
      sim.runUntil(() => {
        track();
        const m = world.getMonster(monsterId)!;
        return m.ai === 'return' || Math.hypot(m.x - to.x, m.z - to.z) < 4;
      }, 15000);
    }
    // 玩家跑远，怪物放弃。
    world.moveTo(playerId, 190.5, 131.5);
    expect(sim.runUntil(() => track() || world.getMonster(monsterId)!.ai === 'return', 15000)).toBe(true);
    const gaveUpAt = world.getMonster(monsterId)!;

    // 确认这个场景有意义：从放弃的位置直线回家会穿过安全区。
    const dx = home.x - gaveUpAt.x;
    const dz = home.z - gaveUpAt.z;
    const t = Math.min(1, Math.max(0, ((128 - gaveUpAt.x) * dx + (128 - gaveUpAt.z) * dz) / (dx * dx + dz * dz)));
    expect(distanceToCenter({ x: gaveUpAt.x + dx * t, z: gaveUpAt.z + dz * t })).toBeLessThan(SAFE_ZONE_RADIUS - 1);

    expect(sim.runUntil(() => track() || world.getMonster(monsterId)!.ai === 'idle', 30000)).toBe(true);
    expect(world.getMonster(monsterId)).toMatchObject({ x: home.x, z: home.z, hp: MONSTER_MAX_HP });
    // 全程（追击和回家）都没有踏进安全区。
    expect(closest).toBeGreaterThanOrEqual(SAFE_ZONE_RADIUS);
  });

  it('很多怪物同时要寻路时，每个 tick 的次数有上限', () => {
    const world = new World(emptyMap(256));
    const sim = new Sim(world);
    const total = MAX_MONSTER_PATHFINDS_PER_TICK * 3 + 6;
    const ids: number[] = [];
    for (let i = 0; i < total; i++) {
      const angle = (i / total) * Math.PI * 2;
      ids.push(world.spawnMonster(60.5 + Math.cos(angle) * 5, 60.5 + Math.sin(angle) * 5));
    }
    world.join('a', new FakeConn(), 0, { x: 60.5, z: 60.5 });

    sim.tick();
    expect(world.monsterPathfinds).toBe(MAX_MONSTER_PATHFINDS_PER_TICK);
    sim.tick();
    expect(world.monsterPathfinds).toBe(MAX_MONSTER_PATHFINDS_PER_TICK * 2);
    sim.tick(2);
    expect(world.monsterPathfinds).toBe(total);
    expect(ids.every((id) => world.getMonster(id)!.ai === 'chase')).toBe(true);
  });
});

describe('玩家的死亡、复活和回血', () => {
  /** 四只怪物围着玩家 a 打；b 站在仇恨范围外旁观。 */
  function setupDeath() {
    const world = new World(emptyMap(256));
    const sim = new Sim(world);
    const monsterIds = [
      world.spawnMonster(41.5, 40.5),
      world.spawnMonster(39.5, 40.5),
      world.spawnMonster(40.5, 41.5),
      world.spawnMonster(40.5, 39.5),
    ];
    const a = new FakeConn();
    const b = new FakeConn();
    const idA = world.join('a', a, 0, { x: 40.5, z: 40.5 });
    const idB = world.join('b', b, 0, { x: 52.5, z: 40.5 });
    return { world, sim, monsterIds, a, b, idA, idB };
  }

  it('血量归零后倒地：不能移动和选目标，快照里是死亡状态', () => {
    const { world, sim, monsterIds, a, b, idA } = setupDeath();
    expect(sim.runUntil(() => world.getPlayer(idA)!.dead, 20000)).toBe(true);
    expect(world.getPlayer(idA)).toMatchObject({ hp: 0, dead: true, moving: false, x: 40.5, z: 40.5 });

    expect(world.moveTo(idA, 45, 40.5)).toBe(false);
    expect(world.setTarget(idA, monsterIds[0])).toBe(false);
    a.take();
    b.take();
    sim.tick(2);
    expect(lastSnapOf(a.take(), idA)).toEqual([idA, 40.5, 40.5, STATE_DEAD, 0]);
    expect(lastSnapOf(b.take(), idA)).toEqual([idA, 40.5, 40.5, STATE_DEAD, 0]);

    // 怪物不再打尸体。
    const hitsBefore = world.stats.hits;
    sim.runMs(2000);
    expect(world.stats.hits).toBe(hitsBefore);
  });

  it('过一段时间在出生点满血复活，自己和旁观者都收到 leave 和 enter', () => {
    const { world, sim, monsterIds, a, b, idA, idB } = setupDeath();
    sim.runUntil(() => world.getPlayer(idA)!.dead, 20000);
    const diedAt = sim.now;
    a.take();
    b.take();

    sim.runMs(PLAYER_RESPAWN_MS - TICK_MS);
    expect(world.getPlayer(idA)!.dead).toBe(true);
    sim.tick();
    expect(sim.now - diedAt).toBe(PLAYER_RESPAWN_MS);

    const after = world.getPlayer(idA)!;
    expect(after).toMatchObject({ hp: PLAYER_MAX_HP, dead: false, moving: false });
    expect(Math.hypot(after.x - 128, after.z - 128)).toBeLessThanOrEqual(SPAWN_RADIUS + 0.01);

    // a：先忘掉原来视野里的怪物和 b，再在新位置看到自己。
    const msgsA = a.take();
    expect(leftIds(msgsA).sort((x, y) => x - y)).toEqual([...monsterIds, idB].sort((x, y) => x - y));
    const selfInfo = enteredInfos(msgsA).find((e) => e.id === idA);
    expect(selfInfo).toMatchObject({ hp: PLAYER_MAX_HP, state: 0 });
    expect(enteredInfos(msgsA).map((e) => e.id)).toEqual([idA]);
    // b：a 从视野里消失。
    expect(leftIds(b.take())).toEqual([idA]);

    // 复活后可以正常移动。
    expect(world.moveTo(idA, after.x + 3, after.z)).toBe(true);
  });

  it('脱离战斗一段时间后慢慢回血，回满为止', () => {
    const world = new World(emptyMap(256));
    const sim = new Sim(world);
    world.spawnMonster(40.5, 40.5);
    const id = world.join('a', new FakeConn(), 0, { x: 41.5, z: 40.5 });

    // 挨一下就跑。
    world.moveTo(id, 91.5, 40.5);
    sim.tick();
    expect(world.getPlayer(id)!.hp).toBe(PLAYER_MAX_HP - MONSTER_ATTACK_DAMAGE);
    const hitAt = sim.now;

    sim.runMs(REGEN_DELAY_MS - TICK_MS);
    expect(world.getPlayer(id)!.hp).toBe(PLAYER_MAX_HP - MONSTER_ATTACK_DAMAGE);
    sim.runMs(1000);
    const regenerating = world.getPlayer(id)!.hp;
    expect(regenerating).toBeGreaterThan(PLAYER_MAX_HP - MONSTER_ATTACK_DAMAGE);
    expect(regenerating).toBeLessThan(PLAYER_MAX_HP);
    expect(sim.now - hitAt).toBeLessThan(REGEN_DELAY_MS + 1500);

    sim.runMs(5000);
    expect(world.getPlayer(id)!.hp).toBe(PLAYER_MAX_HP);
  });

  it('带着存档的血量进入世界，并且不会一上线就回血', () => {
    const world = new World(emptyMap(256));
    const sim = new Sim(world);
    const conn = new FakeConn();
    const id = world.join('a', conn, 0, { x: 40.5, z: 40.5 }, 37);
    expect(enteredInfos(conn.take())[0]).toMatchObject({ id, hp: 37, maxHp: PLAYER_MAX_HP });

    sim.runMs(REGEN_DELAY_MS - TICK_MS);
    expect(world.getPlayer(id)!.hp).toBe(37);
    sim.runMs(1000);
    expect(world.getPlayer(id)!.hp).toBeGreaterThan(37);

    // 存档里的异常值会被限制在 1 到满血之间。
    expect(world.getPlayer(world.join('b', new FakeConn(), 0, { x: 40.5, z: 40.5 }, 0))!.hp).toBe(1);
    expect(world.getPlayer(world.join('c', new FakeConn(), 0, { x: 40.5, z: 40.5 }, 99999))!.hp).toBe(PLAYER_MAX_HP);
  });
});

describe('怪物的生成和视野', () => {
  it('按种子在安全区外的可行走位置生成，同一个种子位置相同', () => {
    const map = generateMap(20261127);
    const world = new World(map);
    const count = world.spawnMonsters(120);
    expect(count).toBe(120);
    expect(world.monsterCount).toBe(120);

    const other = new World(generateMap(20261127));
    other.spawnMonsters(120);
    for (let id = 1; id <= count; id++) {
      const m = world.getMonster(id)!;
      expect(isWalkable(map, m.x, m.z)).toBe(true);
      expect(Math.hypot(m.x - 128, m.z - 128)).toBeGreaterThan(SAFE_ZONE_RADIUS + 5);
      expect(other.getMonster(id)).toEqual(m);
    }
  });

  it('怪物和玩家一样按视野下发：附近的出现在 enter 和快照里，远处的不出现', () => {
    const world = new World(emptyMap(256));
    const sim = new Sim(world);
    const near = world.spawnMonster(60.5, 40.5); // 和玩家同一格
    const far = world.spawnMonster(200.5, 200.5);
    const conn = new FakeConn();
    const id = world.join('a', conn, 0, { x: 40.5, z: 40.5 });

    const infos = enteredInfos(conn.take());
    expect(infos.map((e) => e.id).sort((a, b) => a - b)).toEqual([near, id].sort((a, b) => a - b));
    expect(infos.find((e) => e.id === near)).toEqual({
      id: near,
      kind: 'monster',
      name: expect.any(String),
      x: 60.5,
      z: 40.5,
      state: 0,
      hp: MONSTER_MAX_HP,
      maxHp: MONSTER_MAX_HP,
    });

    sim.tick(2);
    const msgs = conn.take();
    expect(lastSnapOf(msgs, near)).toEqual([near, 60.5, 40.5, 0, MONSTER_MAX_HP]);
    expect(lastSnapOf(msgs, far)).toBeUndefined();
  });

  it('怪物走进或走出玩家的视野时，玩家收到 enter 和 leave', () => {
    const world = new World(emptyMap(256));
    const sim = new Sim(world);
    // 怪物在格子 x = 3（96–128），旁观者在格子 x = 1，一开始看不到它。
    const monsterId = world.spawnMonster(97.5, 40.5);
    const watcher = new FakeConn();
    world.join('watcher', watcher, 0, { x: 60.5, z: 40.5 });
    expect(enteredInfos(watcher.take()).some((e) => e.id === monsterId)).toBe(false);

    // 诱饵把怪物引到格子 x = 2，旁观者看到它；怪物脱战回家后又看不到了。
    const bait = world.join('bait', new FakeConn(), 0, { x: 93.5, z: 40.5 });
    expect(sim.runUntil(() => world.getMonster(monsterId)!.x < 96, 5000)).toBe(true);
    expect(enteredInfos(watcher.take()).some((e) => e.id === monsterId)).toBe(true);

    world.leave(bait);
    expect(sim.runUntil(() => world.getMonster(monsterId)!.ai === 'idle', 10000)).toBe(true);
    expect(leftIds(watcher.take())).toContain(monsterId);
  });
});
