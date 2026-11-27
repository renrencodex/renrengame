import { describe, expect, it } from 'vitest';
import { CharacterStore, spawnFromSave } from '../src/characters';
import type { Queryable, SavedCharacter } from '../src/characters';

/**
 * 内存里的假数据库，只认 CharacterStore 用到的两条语句。
 * 可以让下一次写入失败，或者把查询卡住，用来排出特定的先后顺序。
 */
class FakeDb implements Queryable {
  readonly rows = new Map<number, SavedCharacter | null>();
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
      const result = row === undefined ? [] : [{ x: row?.x ?? null, z: row?.z ?? null, hp: row?.hp ?? null }];
      await this.wait();
      return { rows: result };
    }
    await this.wait();
    if (this.failNextUpdate) {
      this.failNextUpdate = false;
      throw new Error('connection lost');
    }
    const [ids, xs, zs, hps] = params as [number[], number[], number[], number[]];
    ids.forEach((id, i) => {
      if (this.rows.has(id)) this.rows.set(id, { x: xs[i], z: zs[i], hp: hps[i] });
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
  db.rows.set(2, { x: 10, z: 20, hp: 80 });
  db.rows.set(3, { x: 1, z: 2, hp: null });
  return { db, store: new CharacterStore(db) };
}

describe('spawnFromSave', () => {
  const walkable = () => true;

  it('没有存档时位置和血量都交给世界决定', () => {
    expect(spawnFromSave(null, walkable)).toEqual({});
  });

  it('有存档时回到原来的位置和血量', () => {
    expect(spawnFromSave({ x: 10, z: 20, hp: 37 }, walkable)).toEqual({ spawn: { x: 10, z: 20 }, hp: 37 });
  });

  it('存档里没有血量时只恢复位置', () => {
    expect(spawnFromSave({ x: 10, z: 20, hp: null }, walkable)).toEqual({ spawn: { x: 10, z: 20 }, hp: undefined });
  });

  it('下线时是死亡状态，再上线时在出生点满血复活', () => {
    expect(spawnFromSave({ x: 10, z: 20, hp: 0 }, walkable)).toEqual({});
  });

  it('存的位置不可走时只保留血量', () => {
    expect(spawnFromSave({ x: 10, z: 20, hp: 37 }, () => false)).toEqual({ spawn: undefined, hp: 37 });
  });
});

describe('CharacterStore', () => {
  it('区分没进过游戏的角色、有存档的角色和不存在的角色', async () => {
    const { store } = setup();
    expect(await store.load(1)).toBeNull();
    expect(await store.load(2)).toEqual({ x: 10, z: 20, hp: 80 });
    expect(await store.load(99)).toBeUndefined();
  });

  it('加血量这一列之前存的角色，读出来血量是 null', async () => {
    const { store } = setup();
    expect(await store.load(3)).toEqual({ x: 1, z: 2, hp: null });
  });

  it('flush 把记下的位置和血量批量写进库，同一个角色只保留最新的', async () => {
    const { db, store } = setup();
    store.markDirty(1, { x: 1, z: 1, hp: 100 });
    store.markDirty(1, { x: 5, z: 6, hp: 90 });
    store.markDirty(2, { x: 7, z: 8, hp: 3 });
    expect(store.pendingCount).toBe(2);
    await store.flush();
    expect(db.updates).toBe(1);
    expect(db.rows.get(1)).toEqual({ x: 5, z: 6, hp: 90 });
    expect(db.rows.get(2)).toEqual({ x: 7, z: 8, hp: 3 });
    expect(store.pendingCount).toBe(0);
  });

  it('没有待写的数据时 flush 不访问数据库', async () => {
    const { db, store } = setup();
    await store.flush();
    expect(db.updates).toBe(0);
  });

  it('还没写进库的位置在读取时优先于库里的旧值', async () => {
    const { store } = setup();
    store.markDirty(2, { x: 30, z: 40, hp: 55 });
    expect(await store.load(2)).toEqual({ x: 30, z: 40, hp: 55 });
  });

  it('写库进行中读取，拿到的也是正在写的新位置', async () => {
    const { db, store } = setup();
    store.markDirty(2, { x: 30, z: 40, hp: 55 });
    db.holdNext();
    const flushing = store.flush();
    expect(await store.load(2)).toEqual({ x: 30, z: 40, hp: 55 });
    db.release();
    await flushing;
    expect(await store.load(2)).toEqual({ x: 30, z: 40, hp: 55 });
  });

  it('读取期间刚好有一批写完时会重读，不会拿到写入前的旧值', async () => {
    const { db, store } = setup();
    db.holdNext();
    const loading = store.load(2); // 已经读到旧值 (10, 20)，但结果还没返回
    store.markDirty(2, { x: 30, z: 40, hp: 55 });
    await store.flush();
    db.release();
    expect(await loading).toEqual({ x: 30, z: 40, hp: 55 });
  });

  it('写库失败时抛出错误并保留数据，下次 flush 重试', async () => {
    const { db, store } = setup();
    store.markDirty(2, { x: 30, z: 40, hp: 55 });
    db.failNextUpdate = true;
    await expect(store.flush()).rejects.toThrow('connection lost');
    expect(store.pendingCount).toBe(1);
    expect(db.rows.get(2)).toEqual({ x: 10, z: 20, hp: 80 });
    expect(await store.load(2)).toEqual({ x: 30, z: 40, hp: 55 });

    await store.flush();
    expect(db.rows.get(2)).toEqual({ x: 30, z: 40, hp: 55 });
    expect(store.pendingCount).toBe(0);
  });

  it('写库失败期间有更新的位置时，重试写的是更新的那个', async () => {
    const { db, store } = setup();
    store.markDirty(2, { x: 30, z: 40, hp: 55 });
    db.failNextUpdate = true;
    db.holdNext();
    const failing = store.flush();
    store.markDirty(2, { x: 50, z: 60, hp: 0 });
    db.release();
    await expect(failing).rejects.toThrow();

    await store.flush();
    expect(db.rows.get(2)).toEqual({ x: 50, z: 60, hp: 0 });
  });

  it('同时调用多次 flush 时按顺序写，后记下的位置不会被先写的覆盖', async () => {
    const { db, store } = setup();
    store.markDirty(2, { x: 30, z: 40, hp: 55 });
    db.holdNext();
    const first = store.flush();
    store.markDirty(2, { x: 50, z: 60, hp: 0 });
    const second = store.flush();
    db.release();
    await Promise.all([first, second]);
    expect(db.updates).toBe(2);
    expect(db.rows.get(2)).toEqual({ x: 50, z: 60, hp: 0 });
  });
});
