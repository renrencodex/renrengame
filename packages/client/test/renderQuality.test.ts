import { describe, expect, it } from 'vitest';
import { RenderQuality } from '../src/renderQuality';

function play(quality: RenderQuality, start: number, duration: number, step: number): number {
  let changes = 0;
  for (let at = start; at < start + duration; at += step) if (quality.update(at, true)) changes++;
  return changes;
}

describe('RenderQuality', () => {
  it('稳定帧率下保持全画质', () => {
    expect(play(new RenderQuality(), 0, 12000, 16)).toBe(0);
  });

  it('慢帧持续多个窗口才降档一次', () => {
    const quality = new RenderQuality();
    expect(play(quality, 0, 3600, 65)).toBe(0);
    expect(play(quality, 3600, 9000, 65)).toBe(1);
    expect(play(quality, 12600, 8000, 16)).toBe(0);
  });

  it('后台暂停会清掉此前正在累计的慢帧', () => {
    const quality = new RenderQuality();
    expect(play(quality, 0, 4900, 70)).toBe(0);
    expect(quality.update(4900, false)).toBe(false);
    expect(play(quality, 12900, 3200, 70)).toBe(0);
    expect(play(quality, 16100, 4900, 70)).toBe(1);
  });
});
