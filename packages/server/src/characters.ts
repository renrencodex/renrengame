export interface Position {
  x: number;
  z: number;
}

/** CharacterStore 用到的数据库接口。pg 的 Pool 满足它，测试里可以换成假的。 */
export interface Queryable {
  query(text: string, params: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
}

/**
 * 角色位置的读取和延迟写回。
 *
 * 游戏循环不能等数据库，所以位置变化先用 markDirty 记在内存里，再由 flush 批量写进库。
 * 写失败时数据留在内存里，下一次 flush 再试。
 */
export class CharacterStore {
  /** 还没开始写的最新位置。 */
  private dirty = new Map<number, Position>();
  /** 正在写的那一批。 */
  private flushing: Map<number, Position> | null = null;
  private flushPromise: Promise<void> | null = null;
  /** 成功完成的写入批次数，loadPosition 用它判断读到的数据是否可能过时。 */
  private flushCount = 0;

  constructor(private readonly db: Queryable) {}

  /** 还没写进库的角色数。 */
  get pendingCount(): number {
    return this.dirty.size + (this.flushing?.size ?? 0);
  }

  markDirty(characterId: number, pos: Position): void {
    this.dirty.set(characterId, { x: pos.x, z: pos.z });
  }

  /**
   * 读角色上次保存的位置。还没进过游戏时返回 null，角色不存在时返回 undefined。
   * 内存里有还没写进库的位置时以它为准。
   */
  async loadPosition(characterId: number): Promise<Position | null | undefined> {
    for (;;) {
      const flushCount = this.flushCount;
      const res = await this.db.query('SELECT x, z FROM characters WHERE id = $1', [characterId]);
      const pending = this.dirty.get(characterId) ?? this.flushing?.get(characterId);
      if (pending) return { x: pending.x, z: pending.z };
      // 查询期间有一批写入刚完成，这次读到的可能是写入之前的值，重读一次。
      if (flushCount !== this.flushCount) continue;
      const row = res.rows.at(0);
      if (!row) return undefined;
      return typeof row.x === 'number' && typeof row.z === 'number' ? { x: row.x, z: row.z } : null;
    }
  }

  /** 把记下的位置写进库。同一时间只有一批在写；写失败时抛出错误，数据保留到下次。 */
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
    for (const [id, pos] of batch) {
      ids.push(id);
      xs.push(pos.x);
      zs.push(pos.z);
    }
    try {
      await this.db.query(
        `UPDATE characters AS c
         SET x = v.x, z = v.z, updated_at = now()
         FROM unnest($1::int[], $2::real[], $3::real[]) AS v(id, x, z)
         WHERE c.id = v.id`,
        [ids, xs, zs],
      );
      this.flushCount++;
    } catch (err) {
      // 放回去等下次再写；这期间有更新的位置就以更新的为准。
      for (const [id, pos] of batch) {
        if (!this.dirty.has(id)) this.dirty.set(id, pos);
      }
      throw err;
    } finally {
      this.flushing = null;
    }
  }
}
