import { describe, expect, it } from 'vitest';
import { emptyMap, MAP_LAYOUT_VERSION, MAX_MOVE_DISTANCE, MAX_PATHFINDS_PER_TICK, SNAPSHOT_EVERY_TICKS, TICK_MS } from '@mmo/shared';
import type { ServerMsg } from '@mmo/shared';
import { World } from '../src/world';
import type { Connection } from '../src/world';

class FakeConn implements Connection {
  readonly messages: ServerMsg[] = [];
  send(msg: ServerMsg): void {
    this.messages.push(msg);
  }
  /** 取出并清空目前收到的消息。 */
  take(): ServerMsg[] {
    return this.messages.splice(0);
  }
}

function enteredIds(msgs: ServerMsg[]): number[] {
  return msgs.flatMap((m) => (m.t === 'enter' ? m.entities.map((e) => e.id) : []));
}

function leftIds(msgs: ServerMsg[]): number[] {
  return msgs.flatMap((m) => (m.t === 'leave' ? m.ids : []));
}

function lastSnapIds(msgs: ServerMsg[]): number[] | null {
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i];
    if (m.t === 'snap') return m.entities.map((e) => e[0]).sort((a, b) => a - b);
  }
  return null;
}

/** 推进 n 个 tick，返回结束时的服务器时间。 */
function runTicks(world: World, n: number, startTime = 0): number {
  let now = startTime;
  for (let i = 0; i < n; i++) {
    now += TICK_MS;
    world.tick(now);
  }
  return now;
}

describe('World', () => {
  it('加入时先收到 welcome，再收到背包和包含自己的 enter', () => {
    const world = new World(emptyMap(256, 4242));
    const conn = new FakeConn();
    const id = world.join('  小明 ', conn, 1000, { x: 100, z: 100 });

    const [welcome, inv, enter, ...rest] = conn.take();
    expect(rest).toEqual([]);
    expect(welcome).toEqual({ t: 'welcome', selfId: id, seed: 4242, mapVersion: MAP_LAYOUT_VERSION, serverTime: 1000 });
    expect(inv).toEqual({ t: 'inv', items: {}, weapon: null });
    expect(enter).toEqual({
      t: 'enter',
      entities: [{ id, kind: 'player', name: '小明', x: 100, z: 100, state: 0, hp: 100, maxHp: 100 }],
    });
    expect(world.playerCount).toBe(1);
  });

  it('不指定出生点时出生在可行走的位置', () => {
    const world = new World(emptyMap(256));
    for (let i = 0; i < 20; i++) {
      const id = world.join('p', new FakeConn(), 0);
      const p = world.getPlayer(id)!;
      expect(Math.hypot(p.x - 128, p.z - 128)).toBeLessThanOrEqual(10.01);
    }
  });

  it('视野内的玩家互相可见，视野外的互不可见', () => {
    const world = new World(emptyMap(256));
    const a = new FakeConn();
    const b = new FakeConn();
    const c = new FakeConn();
    const idA = world.join('a', a, 0, { x: 40, z: 40 }); // 格子 (1, 1)
    const idB = world.join('b', b, 0, { x: 70, z: 40 }); // 格子 (2, 1)，和 a 相邻
    const idC = world.join('c', c, 0, { x: 200, z: 200 }); // 很远

    expect(enteredIds(a.take())).toEqual([idA, idB]);
    expect(enteredIds(b.take()).sort()).toEqual([idA, idB]);
    expect(enteredIds(c.take())).toEqual([idC]);

    runTicks(world, SNAPSHOT_EVERY_TICKS);
    expect(lastSnapIds(a.take())).toEqual([idA, idB]);
    expect(lastSnapIds(b.take())).toEqual([idA, idB]);
    expect(lastSnapIds(c.take())).toEqual([idC]);
  });

  it('走近时互相收到 enter，走远时互相收到 leave', () => {
    const world = new World(emptyMap(256));
    const a = new FakeConn();
    const b = new FakeConn();
    const idA = world.join('a', a, 0, { x: 60, z: 100 }); // 格子 x = 1，视野到 x < 96
    const idB = world.join('b', b, 0, { x: 100, z: 100 }); // 格子 x = 3
    a.take();
    b.take();

    // a 向右走进格子 x = 2，视野扩到 x < 128，b 进入视野。
    expect(world.moveTo(idA, 70, 100)).toBe(true);
    let now = runTicks(world, 60);
    expect(world.getPlayer(idA)).toMatchObject({ x: 70, z: 100, moving: false });
    expect(enteredIds(a.take())).toEqual([idB]);
    expect(enteredIds(b.take())).toEqual([idA]);

    // a 走回去，b 离开视野。
    expect(world.moveTo(idA, 60, 100)).toBe(true);
    now = runTicks(world, 60, now);
    const msgsA = a.take();
    const msgsB = b.take();
    expect(leftIds(msgsA)).toEqual([idB]);
    expect(leftIds(msgsB)).toEqual([idA]);
    expect(lastSnapIds(msgsA)).toEqual([idA]);
    expect(lastSnapIds(msgsB)).toEqual([idB]);
  });

  it('离线时通知视野内的玩家，并且不再出现在快照里', () => {
    const world = new World(emptyMap(256));
    const a = new FakeConn();
    const b = new FakeConn();
    const idA = world.join('a', a, 0, { x: 40, z: 40 });
    const idB = world.join('b', b, 0, { x: 45, z: 40 });
    a.take();

    world.leave(idB);
    expect(leftIds(a.take())).toEqual([idB]);
    expect(world.playerCount).toBe(1);

    runTicks(world, SNAPSHOT_EVERY_TICKS);
    expect(lastSnapIds(a.take())).toEqual([idA]);
    // 重复 leave 或对不存在的玩家操作都不出错。
    world.leave(idB);
    expect(world.moveTo(idB, 50, 50)).toBe(false);
  });

  it('拒绝太远、不可行走和地图外的 moveTo', () => {
    const map = emptyMap(256);
    map.blocked[100 * 256 + 110] = 1; // 格子 (110, 100) 是障碍物
    const world = new World(map);
    const id = world.join('a', new FakeConn(), 0, { x: 100, z: 100 });

    expect(world.moveTo(id, 100 + MAX_MOVE_DISTANCE + 1, 100)).toBe(false);
    expect(world.moveTo(id, 110.5, 100.5)).toBe(false);
    expect(world.moveTo(id, -1, 100)).toBe(false);
    expect(world.moveTo(id, Number.NaN, 100)).toBe(false);
    expect(world.stats.rejectedMoves).toBe(4);

    runTicks(world, 20);
    expect(world.getPlayer(id)).toMatchObject({ x: 100, z: 100, moving: false });

    expect(world.moveTo(id, 100 + MAX_MOVE_DISTANCE - 1, 100)).toBe(true);
  });

  it('移动由服务端按固定速度推进，并绕开障碍物', () => {
    const map = emptyMap(256);
    for (let z = 90; z <= 110; z++) map.blocked[z * 256 + 105] = 1; // x = 105 处的一堵墙
    const world = new World(map);
    const id = world.join('a', new FakeConn(), 0, { x: 100.5, z: 100.5 });

    world.moveTo(id, 110.5, 100.5);
    runTicks(world, 10); // 0.5 秒，速度 6，最多走 3 个单位
    const mid = world.getPlayer(id)!;
    expect(mid.moving).toBe(true);
    expect(Math.hypot(mid.x - 100.5, mid.z - 100.5)).toBeLessThanOrEqual(3.01);

    // 一路上都不能站在墙里。
    for (let i = 0; i < 200; i++) {
      runTicks(world, 1);
      const p = world.getPlayer(id)!;
      expect(map.blocked[Math.floor(p.z) * 256 + Math.floor(p.x)]).toBe(0);
    }
    expect(world.getPlayer(id)).toMatchObject({ x: 110.5, z: 100.5, moving: false });
  });

  it('每个 tick 的寻路次数有上限，超出的排到下一个 tick', () => {
    const world = new World(emptyMap(256));
    const ids: number[] = [];
    const total = MAX_PATHFINDS_PER_TICK * 2 + 5;
    for (let i = 0; i < total; i++) ids.push(world.join(`p${i}`, new FakeConn(), 0, { x: 100, z: 50 + i }));
    for (const id of ids) world.moveTo(id, 120, world.getPlayer(id)!.z);

    const movingCount = () => ids.filter((id) => world.getPlayer(id)!.moving).length;

    world.tick(TICK_MS);
    expect(movingCount()).toBe(MAX_PATHFINDS_PER_TICK);
    world.tick(TICK_MS * 2);
    expect(movingCount()).toBe(MAX_PATHFINDS_PER_TICK * 2);
    world.tick(TICK_MS * 3);
    expect(movingCount()).toBe(total);
    expect(world.stats.pathfinds).toBe(total);
    expect(world.stats.deferredPathfinds).toBeGreaterThan(0);
  });

  it('连续点击时只按最后一次的目标走，并且限制每个玩家的寻路频率', () => {
    const world = new World(emptyMap(256));
    const id = world.join('a', new FakeConn(), 0, { x: 100, z: 100 });

    world.moveTo(id, 110, 100);
    world.moveTo(id, 100, 110);
    world.moveTo(id, 90, 100);
    world.tick(TICK_MS);
    expect(world.stats.pathfinds).toBe(1);

    // 紧接着再点一次：离上次寻路不到 100ms，推迟到之后的 tick。
    world.moveTo(id, 100, 90);
    world.tick(TICK_MS * 2);
    expect(world.stats.pathfinds).toBe(1);
    world.tick(TICK_MS * 3);
    expect(world.stats.pathfinds).toBe(2);

    runTicks(world, 60, TICK_MS * 3);
    expect(world.getPlayer(id)).toMatchObject({ x: 100, z: 90, moving: false });
  });
});
