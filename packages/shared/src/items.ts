/** 物品的种类。新增物品时在 ITEMS 里加一项，客户端再给它配上模型。 */
export type ItemId = 'gold' | 'potion';

export interface ItemDef {
  readonly id: ItemId;
  readonly name: string;
  /** 一个角色最多能带多少个。带满之后地上的这种物品捡不起来。 */
  readonly maxCount: number;
  /** 能不能主动使用。 */
  readonly usable: boolean;
}

export const ITEMS: Readonly<Record<ItemId, ItemDef>> = {
  gold: { id: 'gold', name: '金币', maxCount: 999_999_999, usable: false },
  potion: { id: 'potion', name: '治疗药水', maxCount: 20, usable: true },
};

export const ITEM_IDS = Object.keys(ITEMS) as ItemId[];

export function isItemId(value: unknown): value is ItemId {
  return typeof value === 'string' && Object.hasOwn(ITEMS, value);
}

/** 背包：每种物品的数量。数量为 0 的物品不出现在里面。 */
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
