import { MAX_TRADE_COUNT, MERCHANT_OFFSET_X, MERCHANT_OFFSET_Z, SHOP_RANGE } from './constants';
import { ITEM_IDS, ITEMS } from './items';
import type { Inventory, ItemId } from './items';
import type { Point } from './pathfinding';

/** 商人站的位置。只和地图大小有关，客户端和服务器算出来的一样。 */
export function merchantPosition(mapSize: number): Point {
  return { x: mapSize / 2 + MERCHANT_OFFSET_X, z: mapSize / 2 + MERCHANT_OFFSET_Z };
}

/** (x, z) 离商人是否不超过 range。服务器用默认的 SHOP_RANGE，客户端用更小的 CLIENT_SHOP_RANGE。 */
export function nearMerchant(mapSize: number, x: number, z: number, range: number = SHOP_RANGE): boolean {
  const m = merchantPosition(mapSize);
  return Math.hypot(x - m.x, z - m.z) <= range;
}

/** 商人卖的东西，按 ITEMS 里的顺序。 */
export const SHOP_GOODS: readonly ItemId[] = ITEM_IDS.filter((id) => ITEMS[id].buyPrice !== undefined);

/** 一笔买卖做不成的原因。 */
export type TradeProblem =
  /** 商人不卖（或者不收）这种东西，或者数量不对。 */
  | 'invalid'
  /** 金币不够。 */
  | 'gold'
  /** 背包里这种东西（卖东西时是金币）放不下了。 */
  | 'full'
  /** 背包里没有这么多可卖的。 */
  | 'missing';

function validCount(count: number): boolean {
  return Number.isSafeInteger(count) && count >= 1 && count <= MAX_TRADE_COUNT;
}

/**
 * 背包是 items 的玩家现在最多能买几个 item（受金币、背包上限和单次上限的限制）。
 * 商人不卖这种东西时是 0。
 */
export function maxBuy(items: Inventory, item: ItemId): number {
  const price = ITEMS[item].buyPrice;
  if (price === undefined) return 0;
  const affordable = Math.floor((items.gold ?? 0) / price);
  const room = ITEMS[item].maxCount - (items[item] ?? 0);
  return Math.max(0, Math.min(affordable, room, MAX_TRADE_COUNT));
}

/**
 * 背包是 items 的玩家想买 count 个 item，能买的话返回 null，否则返回原因。
 * 服务器靠它决定买卖成不成，客户端靠它决定按钮能不能点，两边用的是同一份规则。
 */
export function buyProblem(items: Inventory, item: ItemId, count: number): TradeProblem | null {
  const price = ITEMS[item].buyPrice;
  if (price === undefined || !validCount(count)) return 'invalid';
  if ((items[item] ?? 0) + count > ITEMS[item].maxCount) return 'full';
  if ((items.gold ?? 0) < price * count) return 'gold';
  return null;
}

/** 背包是 items 的玩家想卖 count 个 item，能卖的话返回 null，否则返回原因。拿在手里的武器不在背包里，卖不了。 */
export function sellProblem(items: Inventory, item: ItemId, count: number): TradeProblem | null {
  const price = ITEMS[item].sellPrice;
  if (price === undefined || !validCount(count)) return 'invalid';
  if ((items[item] ?? 0) < count) return 'missing';
  if ((items.gold ?? 0) + price * count > ITEMS.gold.maxCount) return 'full';
  return null;
}
