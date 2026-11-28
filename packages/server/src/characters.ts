import { sanitizeInventory } from '@mmo/shared';
import type { Inventory } from '@mmo/shared';

/** 角色要存档的状态：位置、血量和背包。hp 为 0 表示下线时是死亡状态。 */
export interface CharacterState {
  x: number;
  z: number;
  hp: number;
  items: Inventory;
}

/** 从库里读出来的存档。hp 为 null 表示这个角色还没存过血量。 */
export interface SavedCharacter {
  x: number;
  z: number;
  hp: number | null;
  items: Inventory;
}

/**
 * 根据存档决定进入世界时的位置和血量。没有给出的项由世界决定（随机出生点、满血）。
 * - 没有存档：都不给。
 * - 存档是死亡状态（0 血）：都不给，相当于在出生点满血复活。
 * - 存的位置不可走（比如换了地图种子）：只保留血量。
 *
 * 背包不在这里处理：不管是哪种情况，存档里的物品都原样带进世界。
 */
export function spawnFromSave(
  saved: SavedCharacter | null,
  walkable: (x: number, z: number) => boolean,
): { spawn?: { x: number; z: number }; hp?: number } {
  if (!saved) return {};
  if (saved.hp !== null && saved.hp <= 0) return {};
  return {
    spawn: walkable(saved.x, saved.z) ? { x: saved.x, z: saved.z } : undefined,
    hp: saved.hp ?? undefined,
  };
}

/** CharacterStore 用到的数据库接口。pg 的 Pool 满足它，测试里可以换成假的。 */
export interface Queryable {
  query(text: string, params: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
}

/**
 * 角色存档（位置、血量和背包）的读取和延迟写回。
 *
 * 游戏循环不能等数据库，所以变化先用 markDirty 记在内存里，再由 flush 批量写进库。
 * 写失败时数据留在内存里，下一次 flush 再试。
 */
export class CharacterStore {
  /** 还没开始写的最新状态。 */
  private dirty = new Map<number, CharacterState>();
  /** 正在写的那一批。 */
  private flushing: Map<number, CharacterState> | null = null;
  private flushPromise: Promise<void> | null = null;
  /** 成功完成的写入批次数，load 用它判断读到的数据是否可能过时。 */
  private flushCount = 0;

  constructor(private readonly db: Queryable) {}

  /** 还没写进库的角色数。 */
  get pendingCount(): number {
    return this.dirty.size + (this.flushing?.size ?? 0);
  }

  markDirty(characterId: number, state: CharacterState): void {
    this.dirty.set(characterId, { x: state.x, z: state.z, hp: state.hp, items: { ...state.items } });
  }

  /**
   * 读角色上次保存的状态。还没进过游戏时返回 null，角色不存在时返回 undefined。
   * 内存里有还没写进库的状态时以它为准。
   */
  async load(characterId: number): Promise<SavedCharacter | null | undefined> {
    for (;;) {
      const flushCount = this.flushCount;
      const res = await this.db.query('SELECT x, z, hp, items FROM characters WHERE id = $1', [characterId]);
      const pending = this.dirty.get(characterId) ?? this.flushing?.get(characterId);
      if (pending) return { x: pending.x, z: pending.z, hp: pending.hp, items: { ...pending.items } };
      // 查询期间有一批写入刚完成，这次读到的可能是写入之前的值，重读一次。
      if (flushCount !== this.flushCount) continue;
      const row = res.rows.at(0);
      if (!row) return undefined;
      if (typeof row.x !== 'number' || typeof row.z !== 'number') return null;
      return {
        x: row.x,
        z: row.z,
        hp: typeof row.hp === 'number' ? row.hp : null,
        // 库里存的是 JSON，这里只留下认识的物品和合法的数量。
        items: sanitizeInventory(row.items),
      };
    }
  }

  /** 把记下的状态写进库。同一时间只有一批在写；写失败时抛出错误，数据保留到下次。 */
  async flush(): Promise<void> {
    while (this.flushPromise) await this.flushPromise.catch(() => {});
    if (this.dirty.size === 0) return;
    this.flushPromise = this.writeBatch();
    try {
      await this.flushPromise;
    } finally {
      this.flushPromise = null;
    }
  }

  private async writeBatch(): Promise<void> {
    const batch = this.dirty;
    this.dirty = new Map();
    this.flushing = batch;
    const ids: number[] = [];
    const xs: number[] = [];
    const zs: number[] = [];
    const hps: number[] = [];
    // 背包按 JSON 文本传，到库里再转成 jsonb。
    const items: string[] = [];
    for (const [id, state] of batch) {
      ids.push(id);
      xs.push(state.x);
      zs.push(state.z);
      hps.push(state.hp);
      items.push(JSON.stringify(state.items));
    }
    try {
      await this.db.query(
        `UPDATE characters AS c
         SET x = v.x, z = v.z, hp = v.hp, items = v.items::jsonb, updated_at = now()
         FROM unnest($1::int[], $2::real[], $3::real[], $4::int[], $5::text[]) AS v(id, x, z, hp, items)
         WHERE c.id = v.id`,
        [ids, xs, zs, hps, items],
      );
      this.flushCount++;
    } catch (err) {
      // 放回去等下次再写；这期间有更新的状态就以更新的为准。
      for (const [id, state] of batch) {
        if (!this.dirty.has(id)) this.dirty.set(id, state);
      }
      throw err;
    } finally {
      this.flushing = null;
    }
  }
}
