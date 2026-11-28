import { describe, expect, it } from 'vitest';
import {
  CLIENT_SHOP_RANGE,
  emptyMap,
  ITEMS,
  MAX_TRADE_COUNT,
  merchantPosition,
  SHOP_RANGE,
  TICK_MS,
} from '@mmo/shared';
import type { Inventory, ServerMsg } from '@mmo/shared';
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

/** 不是快照的消息。 */
function events(msgs: ServerMsg[]): ServerMsg[] {
  return msgs.filter((m) => m.t !== 'snap');
}

const SIZE = 256;
const MERCHANT = merchantPosition(SIZE);
const POTION_BUY = ITEMS.potion.buyPrice as number;
const POTION_SELL = ITEMS.potion.sellPrice as number;
const SWORD_BUY = ITEMS.sword.buyPrice as number;
const SWORD_SELL = ITEMS.sword.sellPrice as number;

/** 一个站在商人旁边（离他 distance 远）的玩家。 */
function shopper(items: Inventory, distance = 1.5, weapon: 'sword' | null = null) {
  const world = new World(emptyMap(SIZE), () => 0.5);
  const conn = new FakeConn();
  const id = world.join('买家', conn, 0, { x: MERCHANT.x - distance, z: MERCHANT.z }, undefined, items, weapon);
  conn.take();
  return { world, conn, id };
}

describe('向商人买东西', () => {
  it('买一瓶药水：金币减少，药水增加，自己收到新的背包', () => {
    const { world, conn, id } = shopper({ gold: POTION_BUY + 7 });
    expect(world.buy(id, 'potion', 1)).toBe(true);
    expect(world.getPlayer(id)?.items).toEqual({ gold: 7, potion: 1 });
    expect(conn.take()).toEqual([{ t: 'inv', items: { gold: 7, potion: 1 }, weapon: null }]);
    expect(world.stats.bought).toBe(1);
  });

  it('一次买几瓶，按数量收钱；金币正好花完时背包里不再有金币这一项', () => {
    const { world, conn, id } = shopper({ gold: POTION_BUY * 3, potion: 2 });
    expect(world.buy(id, 'potion', 3)).toBe(true);
    expect(world.getPlayer(id)?.items).toEqual({ potion: 5 });
    expect(conn.take()).toEqual([{ t: 'inv', items: { potion: 5 }, weapon: null }]);
    expect(world.stats.bought).toBe(3);
  });

  it('买一把剑：放进背包，不会自动拿在手里，别人也不会收到任何消息', () => {
    const { world, conn, id } = shopper({ gold: SWORD_BUY });
    const other = new FakeConn();
    world.join('路人', other, 0, { x: MERCHANT.x, z: MERCHANT.z + 2 });
    conn.take();
    other.take();

    expect(world.buy(id, 'sword', 1)).toBe(true);
    expect(world.getPlayer(id)).toMatchObject({ items: { sword: 1 }, weapon: null });
    expect(conn.take()).toEqual([{ t: 'inv', items: { sword: 1 }, weapon: null }]);
    expect(other.take()).toEqual([]);
    // 买来的剑和捡来的一样可以装备。
    expect(world.equip(id, 'sword')).toBe(true);
    expect(world.getPlayer(id)).toMatchObject({ items: {}, weapon: 'sword' });
  });

  it('金币不够时买不成，背包不变，也不发消息', () => {
    const { world, conn, id } = shopper({ gold: POTION_BUY * 2 - 1 });
    expect(world.buy(id, 'potion', 2)).toBe(false);
    expect(world.buy(id, 'sword', 1)).toBe(false);
    expect(world.getPlayer(id)?.items).toEqual({ gold: POTION_BUY * 2 - 1 });
    expect(conn.take()).toEqual([]);
    expect(world.stats.bought).toBe(0);
    // 少买一瓶就够了。
    expect(world.buy(id, 'potion', 1)).toBe(true);
  });

  it('背包里放不下时买不成：不会只买一部分，也不会收了钱不给东西', () => {
    const max = ITEMS.potion.maxCount;
    const { world, conn, id } = shopper({ gold: 1000, potion: max - 1 });
    expect(world.buy(id, 'potion', 2)).toBe(false);
    expect(world.getPlayer(id)?.items).toEqual({ gold: 1000, potion: max - 1 });
    expect(conn.take()).toEqual([]);
    expect(world.buy(id, 'potion', 1)).toBe(true);
    expect(world.buy(id, 'potion', 1)).toBe(false);
    expect(world.getPlayer(id)?.items).toEqual({ gold: 1000 - POTION_BUY, potion: max });
  });

  it('手里拿着的剑不占背包的位置：背包里的剑满了才买不了', () => {
    const max = ITEMS.sword.maxCount;
    const { world, id } = shopper({ gold: SWORD_BUY * 2, sword: max - 1 }, 1.5, 'sword');
    expect(world.buy(id, 'sword', 1)).toBe(true);
    expect(world.buy(id, 'sword', 1)).toBe(false);
    expect(world.getPlayer(id)).toMatchObject({ items: { gold: SWORD_BUY, sword: max }, weapon: 'sword' });
  });

  it('商人不卖金币；数量不像话的请求不理', () => {
    const { world, conn, id } = shopper({ gold: 100000 });
    expect(world.buy(id, 'gold', 1)).toBe(false);
    for (const count of [0, -1, 1.5, NaN, Infinity, MAX_TRADE_COUNT + 1]) {
      expect(world.buy(id, 'potion', count), String(count)).toBe(false);
    }
    expect(world.getPlayer(id)?.items).toEqual({ gold: 100000 });
    expect(conn.take()).toEqual([]);
  });

  it('不存在的玩家买不了', () => {
    const { world } = shopper({ gold: 100 });
    expect(world.buy(999, 'potion', 1)).toBe(false);
  });
});

describe('把东西卖给商人', () => {
  it('卖一瓶药水：药水减少，金币增加，自己收到新的背包', () => {
    const { world, conn, id } = shopper({ gold: 3, potion: 2 });
    expect(world.sell(id, 'potion', 1)).toBe(true);
    expect(world.getPlayer(id)?.items).toEqual({ gold: 3 + POTION_SELL, potion: 1 });
    expect(conn.take()).toEqual([{ t: 'inv', items: { gold: 3 + POTION_SELL, potion: 1 }, weapon: null }]);
    expect(world.stats.sold).toBe(1);
  });

  it('一次卖掉全部：背包里不再有这种东西', () => {
    const { world, id } = shopper({ sword: 3 });
    expect(world.sell(id, 'sword', 3)).toBe(true);
    expect(world.getPlayer(id)?.items).toEqual({ gold: SWORD_SELL * 3 });
    expect(world.stats.sold).toBe(3);
  });

  it('不够数时卖不成，一个也不卖', () => {
    const { world, conn, id } = shopper({ potion: 2 });
    expect(world.sell(id, 'potion', 3)).toBe(false);
    expect(world.sell(id, 'sword', 1)).toBe(false);
    expect(world.getPlayer(id)?.items).toEqual({ potion: 2 });
    expect(conn.take()).toEqual([]);
  });

  it('手里拿着的剑卖不掉，收回背包之后才能卖', () => {
    const { world, id } = shopper({}, 1.5, 'sword');
    expect(world.sell(id, 'sword', 1)).toBe(false);
    expect(world.getPlayer(id)).toMatchObject({ items: {}, weapon: 'sword' });
    expect(world.unequip(id)).toBe(true);
    expect(world.sell(id, 'sword', 1)).toBe(true);
    expect(world.getPlayer(id)).toMatchObject({ items: { gold: SWORD_SELL }, weapon: null });
  });

  it('背包里还有一把、手里也有一把时，只卖得掉背包里的那把', () => {
    const { world, id } = shopper({ sword: 1 }, 1.5, 'sword');
    expect(world.sell(id, 'sword', 2)).toBe(false);
    expect(world.sell(id, 'sword', 1)).toBe(true);
    expect(world.getPlayer(id)).toMatchObject({ items: { gold: SWORD_SELL }, weapon: 'sword' });
  });

  it('金币不能卖；金币到上限时别的东西也卖不了', () => {
    const { world, id } = shopper({ gold: ITEMS.gold.maxCount, potion: 1 });
    expect(world.sell(id, 'gold', 1)).toBe(false);
    expect(world.sell(id, 'potion', 1)).toBe(false);
    expect(world.getPlayer(id)?.items).toEqual({ gold: ITEMS.gold.maxCount, potion: 1 });
  });

  it('买进再卖出是亏的', () => {
    const { world, id } = shopper({ gold: SWORD_BUY + POTION_BUY });
    expect(world.buy(id, 'sword', 1)).toBe(true);
    expect(world.buy(id, 'potion', 1)).toBe(true);
    expect(world.sell(id, 'sword', 1)).toBe(true);
    expect(world.sell(id, 'potion', 1)).toBe(true);
    const gold = world.getPlayer(id)?.items.gold ?? 0;
    expect(gold).toBe(SWORD_SELL + POTION_SELL);
    expect(gold).toBeLessThan(SWORD_BUY + POTION_BUY);
  });
});

describe('买卖的条件', () => {
  it('离商人不超过 SHOP_RANGE 才能买卖，按服务器算的位置', () => {
    const near = shopper({ gold: 100, potion: 1 }, SHOP_RANGE - 0.01);
    expect(near.world.buy(near.id, 'potion', 1)).toBe(true);
    expect(near.world.sell(near.id, 'potion', 1)).toBe(true);

    const far = shopper({ gold: 100, potion: 1 }, SHOP_RANGE + 0.01);
    expect(far.world.buy(far.id, 'potion', 1)).toBe(false);
    expect(far.world.sell(far.id, 'potion', 1)).toBe(false);
    expect(far.world.getPlayer(far.id)?.items).toEqual({ gold: 100, potion: 1 });
    expect(far.conn.take()).toEqual([]);
  });

  it('在地图另一头买不了，走到商人旁边就可以了', () => {
    const world = new World(emptyMap(SIZE), () => 0.5);
    const conn = new FakeConn();
    const start = { x: MERCHANT.x - 12, z: MERCHANT.z };
    const id = world.join('买家', conn, 0, start, undefined, { gold: 100 });
    expect(world.buy(id, 'potion', 1)).toBe(false);

    // 客户端会走到离商人 CLIENT_SHOP_RANGE 以内再发请求，服务器那时一定认可。
    expect(world.moveTo(id, MERCHANT.x - CLIENT_SHOP_RANGE + 0.2, MERCHANT.z)).toBe(true);
    let now = 0;
    for (let i = 0; i < 400; i++) {
      world.tick((now += TICK_MS));
      // 头两个 tick 还没开始走，不算“已经停下”。
      if (i > 2 && !world.getPlayer(id)?.moving) break;
    }
    const p = world.getPlayer(id);
    expect(Math.hypot((p?.x ?? 0) - MERCHANT.x, (p?.z ?? 0) - MERCHANT.z)).toBeLessThanOrEqual(CLIENT_SHOP_RANGE);
    expect(world.buy(id, 'potion', 1)).toBe(true);
  });

  it('边走边买也可以，只看当时离商人多远', () => {
    const { world, id } = shopper({ gold: 100 }, 1);
    expect(world.moveTo(id, MERCHANT.x - 20, MERCHANT.z)).toBe(true);
    let now = 0;
    world.tick((now += TICK_MS));
    world.tick((now += TICK_MS));
    expect(world.getPlayer(id)?.moving).toBe(true);
    expect(world.buy(id, 'potion', 1)).toBe(true);
    // 走远了就不行了。
    for (let i = 0; i < 40; i++) world.tick((now += TICK_MS));
    expect(world.buy(id, 'potion', 1)).toBe(false);
  });

  it('买卖只把背包发给自己，不发别的消息', () => {
    const { world, conn, id } = shopper({ gold: 100 });
    world.buy(id, 'potion', 2);
    world.sell(id, 'potion', 1);
    const msgs = events(conn.take());
    expect(msgs.map((m) => m.t)).toEqual(['inv', 'inv']);
  });
});
