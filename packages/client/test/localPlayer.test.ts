import { describe, expect, it } from 'vitest';
import { CLIENT_MOVE_DISTANCE, emptyMap, MOVE_SPEED } from '@mmo/shared';
import { LocalPlayer } from '../src/localPlayer';

const FRAME = 1 / 60;

/** 推进若干帧，返回结束时的时间（毫秒）。 */
function runFrames(player: LocalPlayer, frames: number, startMs = 0): number {
  let now = startMs;
  for (let i = 0; i < frames; i++) {
    now += FRAME * 1000;
    player.update(FRAME, now);
  }
  return now;
}

describe('LocalPlayer', () => {
  it('点击后立刻按速度朝目标移动，不等服务器', () => {
    const player = new LocalPlayer(emptyMap(256));
    player.place(100, 100);
    expect(player.requestMove(112, 100)).toBe(true);

    runFrames(player, 60);
    expect(player.moving).toBe(true);
    expect(player.x).toBeCloseTo(100 + MOVE_SPEED, 1);

    runFrames(player, 120, 1000);
    expect(player).toMatchObject({ x: 112, z: 100, moving: false });
  });

  it('目标太远、不可行走或走不到时不移动', () => {
    const map = emptyMap(256);
    map.blocked[100 * 256 + 110] = 1;
    const player = new LocalPlayer(map);
    player.place(100.5, 100.5);

    expect(player.requestMove(100.5 + CLIENT_MOVE_DISTANCE + 1, 100.5)).toBe(false);
    expect(player.requestMove(110.5, 100.5)).toBe(false);
    expect(player.requestMove(-3, 100.5)).toBe(false);
    runFrames(player, 30);
    expect(player).toMatchObject({ x: 100.5, z: 100.5, moving: false });
  });

  it('服务端只是慢一点、还在同一条路上时，不纠正', () => {
    const player = new LocalPlayer(emptyMap(256));
    player.place(100, 100);
    player.requestMove(118, 100);

    // 服务端始终落后 200ms，也就是 1.2 个单位。
    let now = 0;
    for (let i = 0; i < 240; i++) {
      now += FRAME * 1000;
      player.update(FRAME, now);
      if (i % 6 === 0) {
        const serverX = Math.min(118, 100 + Math.max(0, now - 200) * 0.001 * MOVE_SPEED);
        player.onServerState(serverX, 100, serverX < 118);
      }
    }
    expect(player.corrections).toBe(0);
    expect(player).toMatchObject({ x: 118, z: 100, moving: false });
  });

  it('服务端位置偏离预测轨迹太远时，改为跟随服务端', () => {
    const player = new LocalPlayer(emptyMap(256));
    player.place(100, 100);
    player.requestMove(118, 100);
    let now = runFrames(player, 30);

    // 服务端说玩家其实在别的地方而且没在动（比如这次移动被拒绝了）。
    player.onServerState(100, 106, false);
    expect(player.corrections).toBe(1);

    now = runFrames(player, 90, now);
    expect(player.x).toBeCloseTo(100, 1);
    expect(player.z).toBeCloseTo(106, 1);
    expect(player.moving).toBe(false);

    // 追上之后可以重新开始预测。
    expect(player.requestMove(100, 112)).toBe(true);
    runFrames(player, 30, now);
    expect(player.moving).toBe(true);
    expect(player.z).toBeGreaterThan(108);
    expect(player.corrections).toBe(1);
  });

  it('到达后服务端迟迟没有跟上来，过一会儿以服务端为准', () => {
    const player = new LocalPlayer(emptyMap(256));
    player.place(100, 100);
    player.requestMove(106, 100);
    let now = runFrames(player, 90);
    expect(player.x).toBe(106);

    // 服务端停在半路。2 秒内仍在最近走过的轨迹上，不算偏离。
    player.onServerState(102, 100, false);
    expect(player.corrections).toBe(0);

    now = runFrames(player, 150, now);
    player.onServerState(102, 100, false);
    expect(player.corrections).toBe(1);
    runFrames(player, 90, now);
    expect(player.x).toBeCloseTo(102, 1);
  });
});
