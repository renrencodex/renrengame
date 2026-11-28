import { PLAYER_ATTACK_DAMAGE } from './constants';

/** 物品的种类。新增物品时在 ITEMS 里加一项，客户端再给它配上模型。 */
export type ItemId = 'gold' | 'potion' | 'sword';

export interface ItemDef {
  readonly id: ItemId;
  readonly name: string;
  /** 背包里最多能放多少个。放满之后地上的这种物品捡不起来。 */
  readonly maxCount: number;
  /** 能不能主动使用（喝掉、吃掉）。 */
  readonly usable: boolean;
  /** 是武器的话，拿在手里时增加多少攻击力。不是武器的物品没有这一项。 */
  readonly weapon?: { readonly damage: number };
  /** 商人卖一个要多少金币。没有这一项的物品商人不卖。 */
  readonly buyPrice?: number;
  /** 卖给商人一个得多少金币。没有这一项的物品商人不收。要比 buyPrice 低，否则可以倒手刷金币。 */
  readonly sellPrice?: number;
}

export const ITEMS: Readonly<Record<ItemId, ItemDef>> = {
  gold: { id: 'gold', name: '金币', maxCount: 999_999_999, usable: false },
  potion: { id: 'potion', name: '治疗药水', maxCount: 20, usable: true, buyPrice: 15, sellPrice: 5 },
  sword: {
    id: 'sword',
    name: '青铜剑',
    maxCount: 5,
    usable: false,
    weapon: { damage: 8 },
    buyPrice: 100,
    sellPrice: 25,
  },
};

export const ITEM_IDS = Object.keys(ITEMS) as ItemId[];

export function isItemId(value: unknown): value is ItemId {
  return typeof value === 'string' && Object.hasOwn(ITEMS, value);
}

/** 背包：每种物品的数量。数量为 0 的物品不出现在里面。拿在手里的武器不算在背包里。 */
export type Inventory = Partial<Record<ItemId, number>>;

/**
 * 把来历不明的数据（比如数据库里存的 JSON）整理成合法的背包：
 * 只保留认识的物品，数量取整并限制在 1 到上限之间。
 */
export function sanitizeInventory(value: unknown): Inventory {
  const out: Inventory = {};
  if (typeof value !== 'object' || value === null) return out;
  const source = value as Record<string, unknown>;
  for (const id of ITEM_IDS) {
    const count = source[id];
    if (typeof count !== 'number' || !Number.isFinite(count)) continue;
    const whole = Math.min(ITEMS[id].maxCount, Math.floor(count));
    if (whole > 0) out[id] = whole;
  }
  return out;
}

/** 两个背包的内容是否完全一样。 */
export function sameInventory(a: Inventory, b: Inventory): boolean {
  for (const id of ITEM_IDS) {
    if ((a[id] ?? 0) !== (b[id] ?? 0)) return false;
  }
  return true;
}

/** 把来历不明的数据整理成“手里的武器”：是一种武器就原样返回，否则当作空手。 */
export function sanitizeWeapon(value: unknown): ItemId | null {
  return isItemId(value) && ITEMS[value].weapon ? value : null;
}

/** 玩家手里拿着 weapon（空手是 null）时，每次攻击造成的伤害。 */
export function attackDamage(weapon: ItemId | null): number {
  return PLAYER_ATTACK_DAMAGE + (weapon ? (ITEMS[weapon].weapon?.damage ?? 0) : 0);
}
