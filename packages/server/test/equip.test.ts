import { describe, expect, it } from 'vitest';
import {
  attackDamage,
  DROP_PICKUP_DELAY_MS,
  emptyMap,
  ITEMS,
  MONSTER_MAX_HP,
  PLAYER_ATTACK_DAMAGE,
  PLAYER_ATTACK_INTERVAL_MS,
  PLAYER_RESPAWN_MS,
  TICK_MS,
} from '@mmo/shared';
import type { CharacterInfo, ServerMsg } from '@mmo/shared';
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

/** 不是快照的消息。快照每隔一个 tick 就有一条，和这里要看的事情无关。 */
function events(msgs: ServerMsg[]): ServerMsg[] {
  return msgs.filter((m) => m.t !== 'snap');
}

function enteredCharacter(msgs: ServerMsg[], id: number): CharacterInfo | undefined {
  for (const m of msgs) {
    if (m.t !== 'enter') continue;
    for (const e of m.entities) if (e.kind !== 'drop' && e.id === id) return e;
  }
  return undefined;
}

function hitDamages(msgs: ServerMsg[]): number[] {
  return msgs.flatMap((m) => (m.t === 'hit' ? [m.damage] : []));
}

/** 这些测试都放在离地图中心的安全区很远的地方。掉落用固定的随机数：不掉药水，也不掉剑。 */
function setup() {
  const world = new World(emptyMap(256), () => 0.5);
  return { world, sim: new Sim(world) };
}

const SWORD_DAMAGE = PLAYER_ATTACK_DAMAGE + ITEMS.sword.weapon!.damage;

describe('装备武器', () => {
  it('把背包里的剑拿在手里：背包少一把，自己收到新的背包，周围的人都看到他换了武器', () => {
    const { world } = setup();
    const a = new FakeConn();
    const b = new FakeConn();
    const far = new FakeConn();
    const id = world.join('a', a, 0, { x: 40.5, z: 40.5 }, undefined, { gold: 5, sword: 2 });
    world.join('b', b, 0, { x: 45.5, z: 40.5 });
    world.join('far', far, 0, { x: 200.5, z: 200.5 });
    a.take();
    b.take();
    far.take();

    expect(world.equip(id, 'sword')).toBe(true);
    expect(world.getPlayer(id)).toMatchObject({ items: { gold: 5, sword: 1 }, weapon: 'sword' });
    const changed: ServerMsg = { t: 'weapon', id, item: 'sword' };
    expect(a.take()).toEqual([{ t: 'inv', items: { gold: 5, sword: 1 }, weapon: 'sword' }, changed]);
    expect(b.take()).toEqual([changed]);
    // 看不到他的人不会收到。
    expect(far.take()).toEqual([]);
  });

  it('收起武器：剑回到背包，周围的人看到他空手了', () => {
    const { world } = setup();
    const a = new FakeConn();
    const b = new FakeConn();
    const id = world.join('a', a, 0, { x: 40.5, z: 40.5 }, undefined, { sword: 1 }, 'sword');
    world.join('b', b, 0, { x: 45.5, z: 40.5 });
    a.take();
    b.take();

    expect(world.unequip(id)).toBe(true);
    expect(world.getPlayer(id)).toMatchObject({ items: { sword: 2 }, weapon: null });
    const changed: ServerMsg = { t: 'weapon', id, item: null };
    expect(a.take()).toEqual([{ t: 'inv', items: { sword: 2 }, weapon: null }, changed]);
    expect(b.take()).toEqual([changed]);

    // 已经空手了，再收一次什么也不发生。
    expect(world.unequip(id)).toBe(false);
    expect(a.take()).toEqual([]);
  });

  it('只有一把剑时，拿起来之后背包里就没有剑了，收起来又回来', () => {
    const { world } = setup();
    const id = world.join('a', new FakeConn(), 0, { x: 40.5, z: 40.5 }, undefined, { sword: 1 });
    expect(world.equip(id, 'sword')).toBe(true);
    expect(world.getPlayer(id)).toMatchObject({ items: {}, weapon: 'sword' });
    expect(world.unequip(id)).toBe(true);
    expect(world.getPlayer(id)).toMatchObject({ items: { sword: 1 }, weapon: null });
  });

  it('背包里没有、不是武器、已经拿着同一种时都装备不了，也不发任何消息', () => {
    const { world } = setup();
    const conn = new FakeConn();
    const id = world.join('a', conn, 0, { x: 40.5, z: 40.5 }, undefined, { gold: 50, potion: 3 });
    const armed = world.join('armed', new FakeConn(), 0, { x: 40.5, z: 40.5 }, undefined, { sword: 1 }, 'sword');
    conn.take();

    expect(world.equip(id, 'sword')).toBe(false);
    expect(world.equip(id, 'potion')).toBe(false);
    expect(world.equip(id, 'gold')).toBe(false);
    expect(world.equip(9999, 'sword')).toBe(false);
    expect(world.unequip(9999)).toBe(false);
    expect(world.getPlayer(id)).toMatchObject({ items: { gold: 50, potion: 3 }, weapon: null });
    expect(conn.take()).toEqual([]);

    // 手里已经是剑了，背包里还有一把：不用换。
    expect(world.equip(armed, 'sword')).toBe(false);
    expect(world.getPlayer(armed)).toMatchObject({ items: { sword: 1 }, weapon: 'sword' });
  });

  it('背包里的剑已经放满时，手里的那把收不回去', () => {
    const { world } = setup();
    const max = ITEMS.sword.maxCount;
    const id = world.join('a', new FakeConn(), 0, { x: 40.5, z: 40.5 }, undefined, { sword: max }, 'sword');
    expect(world.unequip(id)).toBe(false);
    expect(world.getPlayer(id)).toMatchObject({ items: { sword: max }, weapon: 'sword' });
  });

  it('捡到的剑放进背包，不会自己跑到手里', () => {
    const { world, sim } = setup();
    const conn = new FakeConn();
    const id = world.join('a', conn, 0, { x: 40.5, z: 40.5 });
    world.spawnDrop('sword', 1, 40.5, 40.5, sim.now);
    sim.runMs(DROP_PICKUP_DELAY_MS);
    expect(world.getPlayer(id)).toMatchObject({ items: { sword: 1 }, weapon: null });
    expect(events(conn.take()).at(-1)).toEqual({ t: 'inv', items: { sword: 1 }, weapon: null });
  });

  it('背包里的剑放满了，地上的剑捡不起来；手里的那把不占背包的位置', () => {
    const { world, sim } = setup();
    const max = ITEMS.sword.maxCount;
    const id = world.join('a', new FakeConn(), 0, { x: 40.5, z: 40.5 }, undefined, { sword: max - 1 }, 'sword');
    world.spawnDrop('sword', 1, 40.5, 40.5, sim.now);
    world.spawnDrop('sword', 1, 40.5, 41, sim.now);
    sim.runMs(DROP_PICKUP_DELAY_MS + 1000);
    expect(world.getPlayer(id)).toMatchObject({ items: { sword: max }, weapon: 'sword' });
    expect(world.dropCount).toBe(1);
  });
});

describe('武器的效果', () => {
  /** 玩家站在怪物东边一个单位的地方，选中它。 */
  function fight(items: { sword?: number } = {}, weapon: 'sword' | null = null) {
    const { world, sim } = setup();
    const monsterId = world.spawnMonster(100.5, 100.5);
    const conn = new FakeConn();
    const playerId = world.join('a', conn, 0, { x: 101.5, z: 100.5 }, undefined, items, weapon);
    world.setTarget(playerId, monsterId);
    return { world, sim, monsterId, playerId, conn };
  }

  it('拿着剑时每次攻击的伤害更高，打死一只怪物用的次数更少', () => {
    const bare = fight();
    expect(bare.sim.runUntil(() => bare.world.getMonster(bare.monsterId)!.dead, 20000)).toBe(true);
    const bareHits = hitDamages(bare.conn.take().filter((m) => m.t === 'hit' && m.to === bare.monsterId));
    expect(bareHits).toEqual(Array(Math.ceil(MONSTER_MAX_HP / PLAYER_ATTACK_DAMAGE)).fill(PLAYER_ATTACK_DAMAGE));

    const armed = fight({}, 'sword');
    expect(armed.sim.runUntil(() => armed.world.getMonster(armed.monsterId)!.dead, 20000)).toBe(true);
    const armedHits = hitDamages(armed.conn.take().filter((m) => m.t === 'hit' && m.to === armed.monsterId));
    expect(armedHits).toEqual(Array(Math.ceil(MONSTER_MAX_HP / SWORD_DAMAGE)).fill(SWORD_DAMAGE));
    expect(armedHits.length).toBeLessThan(bareHits.length);
    expect(SWORD_DAMAGE).toBe(attackDamage('sword'));
  });

  it('打到一半拿起剑，下一次攻击就按剑的伤害算；收起来又变回空手的伤害', () => {
    const { world, sim, monsterId, playerId, conn } = fight({ sword: 1 });
    const hitsOnMonster = () => hitDamages(conn.messages.filter((m) => m.t === 'hit' && m.to === monsterId));
    expect(sim.runUntil(() => hitsOnMonster().length === 1, 2000)).toBe(true);
    expect(world.equip(playerId, 'sword')).toBe(true);
    expect(sim.runUntil(() => hitsOnMonster().length === 2, 2000)).toBe(true);
    expect(world.unequip(playerId)).toBe(true);
    expect(sim.runUntil(() => hitsOnMonster().length === 3, 2000)).toBe(true);
    expect(hitsOnMonster()).toEqual([PLAYER_ATTACK_DAMAGE, SWORD_DAMAGE, PLAYER_ATTACK_DAMAGE]);
    expect(world.getMonster(monsterId)!.hp).toBe(MONSTER_MAX_HP - 2 * PLAYER_ATTACK_DAMAGE - SWORD_DAMAGE);
  });

  it('换武器不会让攻击变快', () => {
    const { world, sim, monsterId, playerId, conn } = fight({ sword: 1 });
    const hitsOnMonster = () => conn.messages.filter((m) => m.t === 'hit' && m.to === monsterId).length;
    expect(sim.runUntil(() => hitsOnMonster() === 1, 2000)).toBe(true);
    // 冷却期间来回换，不会多打出一下。
    for (let i = 0; i < 4; i++) {
      world.equip(playerId, 'sword');
      world.unequip(playerId);
      sim.tick();
    }
    sim.runMs(PLAYER_ATTACK_INTERVAL_MS - 5 * TICK_MS);
    expect(hitsOnMonster()).toBe(1);
    sim.tick();
    expect(hitsOnMonster()).toBe(2);
  });
});

describe('武器和视野、存档', () => {
  it('带着存档的武器进入世界：一上线就收到，后来看到他的人也知道他拿着什么', () => {
    const { world, sim } = setup();
    const a = new FakeConn();
    const id = world.join('a', a, 0, { x: 40.5, z: 40.5 }, undefined, { sword: 1 }, 'sword');
    const first = a.take();
    expect(first[1]).toEqual({ t: 'inv', items: { sword: 1 }, weapon: 'sword' });
    expect(enteredCharacter(first, id)).toMatchObject({ kind: 'player', weapon: 'sword' });
    expect(world.getPlayer(id)!.weapon).toBe('sword');

    // 上线时就在旁边的人。
    const b = new FakeConn();
    const idB = world.join('b', b, 0, { x: 45.5, z: 40.5 });
    expect(enteredCharacter(b.take(), id)).toMatchObject({ weapon: 'sword' });
    // 空手的人和怪物的信息里没有这一项。
    expect(enteredCharacter(a.take(), idB)).not.toHaveProperty('weapon');
    const monsterId = world.spawnMonster(60.5, 60.5);
    expect(enteredCharacter(a.take(), monsterId)).not.toHaveProperty('weapon');

    // 从远处走过来才看到他的人。
    const c = new FakeConn();
    const idC = world.join('c', c, 0, { x: 100.5, z: 40.5 });
    expect(enteredCharacter(c.take(), id)).toBeUndefined();
    world.moveTo(idC, 90.5, 40.5);
    expect(sim.runUntil(() => enteredCharacter(c.messages, id) !== undefined, 3000)).toBe(true);
    expect(enteredCharacter(c.take(), id)).toMatchObject({ weapon: 'sword' });
  });

  it('存档里的武器不是物品表里的武器时，进入世界是空手', () => {
    const { world } = setup();
    const conn = new FakeConn();
    const id = world.join('a', conn, 0, { x: 40.5, z: 40.5 }, undefined, { potion: 1 }, 'potion');
    expect(world.getPlayer(id)).toMatchObject({ items: { potion: 1 }, weapon: null });
    const other = world.join('b', new FakeConn(), 0, { x: 40.5, z: 40.5 }, undefined, {}, 'wand' as never);
    expect(world.getPlayer(other)!.weapon).toBeNull();
    expect(enteredCharacter(conn.take(), other)).not.toHaveProperty('weapon');
  });

  it('死了不掉武器，但死着的时候不能换；复活后剑还在手里', () => {
    const { world, sim } = setup();
    for (const [x, z] of [
      [41.5, 40.5],
      [39.5, 40.5],
      [40.5, 41.5],
      [40.5, 39.5],
    ]) {
      world.spawnMonster(x, z);
    }
    const conn = new FakeConn();
    const id = world.join('a', conn, 0, { x: 40.5, z: 40.5 }, undefined, { sword: 1 }, 'sword');
    expect(sim.runUntil(() => world.getPlayer(id)!.dead, 20000)).toBe(true);
    expect(world.unequip(id)).toBe(false);
    expect(world.getPlayer(id)).toMatchObject({ dead: true, items: { sword: 1 }, weapon: 'sword' });

    conn.take();
    sim.runMs(PLAYER_RESPAWN_MS);
    expect(world.getPlayer(id)).toMatchObject({ dead: false, items: { sword: 1 }, weapon: 'sword' });
    // 复活是“离开再进入”，重新进入时的信息里带着武器。
    expect(enteredCharacter(conn.take(), id)).toMatchObject({ weapon: 'sword' });
  });
});
