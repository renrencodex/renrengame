import { describe, expect, it } from 'vitest';
import { CharacterStore } from '../src/characters';
import type { Position, Queryable } from '../src/characters';

/**
 * 内存里的假数据库，只认 CharacterStore 用到的两条语句。
 * 可以让下一次写入失败，或者把查询卡住，用来排出特定的先后顺序。
 */
class FakeDb implements Queryable {
  readonly rows = new Map<number, Position | null>();
  updates = 0;
  failNextUpdate = false;
  /** 设置后，下一条语句会等到 release 被调用才真正执行。 */
  private gate: Promise<void> | null = null;
  private openGate: () => void = () => {};

  holdNext(): void {
    this.gate = new Promise((resolve) => (this.openGate = resolve));
  }

  release(): void {
    this.openGate();
  }

  async query(text: string, params: unknown[]): Promise<{ rows: Record<string, unknown>[] }> {
    if (text.startsWith('SELECT')) {
      // 和真实数据库一样：结果是语句执行那一刻的数据，之后才返回给调用方。
      const row = this.rows.get(params[0] as number);
      const result = row === undefined ? [] : [{ x: row?.x ?? null, z: row?.z ?? null }];
      await this.wait();
      return { rows: result };
    }
    await this.wait();
    if (this.failNextUpdate) {
      this.failNextUpdate = false;
      throw new Error('connection lost');
    }
    const [ids, xs, zs] = params as [number[], number[], number[]];
    ids.forEach((id, i) => {
      if (this.rows.has(id)) this.rows.set(id, { x: xs[i], z: zs[i] });
    });
    this.updates++;
    return { rows: [] };
  }

  private async wait(): Promise<void> {
    const gate = this.gate;
    this.gate = null;
    await gate;
  }
}

function setup() {
  const db = new FakeDb();
  db.rows.set(1, null);
  db.rows.set(2, { x: 10, z: 20 });
  return { db, store: new CharacterStore(db) };
}

describe('CharacterStore', () => {
  it('区分没进过游戏的角色、有存档的角色和不存在的角色', async () => {
    const { store } = setup();
    expect(await store.loadPosition(1)).toBeNull();
    expect(await store.loadPosition(2)).toEqual({ x: 10, z: 20 });
    expect(await store.loadPosition(99)).toBeUndefined();
  });

  it('flush 把记下的位置批量写进库，同一个角色只保留最新的', async () => {
    const { db, store } = setup();
    store.markDirty(1, { x: 1, z: 1 });
    store.markDirty(1, { x: 5, z: 6 });
    store.markDirty(2, { x: 7, z: 8 });
    expect(store.pendingCount).toBe(2);
    await store.flush();
    expect(db.updates).toBe(1);
    expect(db.rows.get(1)).toEqual({ x: 5, z: 6 });
    expect(db.rows.get(2)).toEqual({ x: 7, z: 8 });
    expect(store.pendingCount).toBe(0);
  });

  it('没有待写的数据时 flush 不访问数据库', async () => {
    const { db, store } = setup();
    await store.flush();
    expect(db.updates).toBe(0);
  });

  it('还没写进库的位置在读取时优先于库里的旧值', async () => {
    const { store } = setup();
    store.markDirty(2, { x: 30, z: 40 });
    expect(await store.loadPosition(2)).toEqual({ x: 30, z: 40 });
  });

  it('写库进行中读取，拿到的也是正在写的新位置', async () => {
    const { db, store } = setup();
    store.markDirty(2, { x: 30, z: 40 });
    db.holdNext();
    const flushing = store.flush();
    expect(await store.loadPosition(2)).toEqual({ x: 30, z: 40 });
    db.release();
    await flushing;
    expect(await store.loadPosition(2)).toEqual({ x: 30, z: 40 });
  });

  it('读取期间刚好有一批写完时会重读，不会拿到写入前的旧值', async () => {
    const { db, store } = setup();
    db.holdNext();
    const loading = store.loadPosition(2); // 已经读到旧值 (10, 20)，但结果还没返回
    store.markDirty(2, { x: 30, z: 40 });
    await store.flush();
    db.release();
    expect(await loading).toEqual({ x: 30, z: 40 });
  });

  it('写库失败时抛出错误并保留数据，下次 flush 重试', async () => {
    const { db, store } = setup();
    store.markDirty(2, { x: 30, z: 40 });
    db.failNextUpdate = true;
    await expect(store.flush()).rejects.toThrow('connection lost');
    expect(store.pendingCount).toBe(1);
    expect(db.rows.get(2)).toEqual({ x: 10, z: 20 });
    expect(await store.loadPosition(2)).toEqual({ x: 30, z: 40 });

    await store.flush();
    expect(db.rows.get(2)).toEqual({ x: 30, z: 40 });
    expect(store.pendingCount).toBe(0);
  });

  it('写库失败期间有更新的位置时，重试写的是更新的那个', async () => {
    const { db, store } = setup();
    store.markDirty(2, { x: 30, z: 40 });
    db.failNextUpdate = true;
    db.holdNext();
    const failing = store.flush();
    store.markDirty(2, { x: 50, z: 60 });
    db.release();
    await expect(failing).rejects.toThrow();

    await store.flush();
    expect(db.rows.get(2)).toEqual({ x: 50, z: 60 });
  });

  it('同时调用多次 flush 时按顺序写，后记下的位置不会被先写的覆盖', async () => {
    const { db, store } = setup();
    store.markDirty(2, { x: 30, z: 40 });
    db.holdNext();
    const first = store.flush();
    store.markDirty(2, { x: 50, z: 60 });
    const second = store.flush();
    db.release();
    await Promise.all([first, second]);
    expect(db.updates).toBe(2);
    expect(db.rows.get(2)).toEqual({ x: 50, z: 60 });
  });
});
