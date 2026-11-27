import { describe, expect, it } from 'vitest';
import { SnapshotBuffer } from '../src/interpolation';
import type { Sample } from '../src/interpolation';

function sampleAt(buffer: SnapshotBuffer, time: number): Sample | null {
  const out: Sample = { x: 0, z: 0, moving: false };
  return buffer.sample(time, out) ? out : null;
}

describe('SnapshotBuffer', () => {
  it('缓冲为空时没有结果', () => {
    expect(sampleAt(new SnapshotBuffer(), 100)).toBeNull();
  });

  it('在前后两个快照之间线性插值', () => {
    const buffer = new SnapshotBuffer();
    buffer.push(1000, 0, 0, true);
    buffer.push(1100, 6, 2, true);
    buffer.push(1200, 12, 4, true);
    expect(sampleAt(buffer, 1050)).toEqual({ x: 3, z: 1, moving: true });
    expect(sampleAt(buffer, 1175)).toEqual({ x: 10.5, z: 3.5, moving: true });
    expect(sampleAt(buffer, 1100)).toEqual({ x: 6, z: 2, moving: true });
  });

  it('比最早的快照还早或超过最新的快照时，停在已知位置', () => {
    const buffer = new SnapshotBuffer();
    buffer.push(1000, 1, 1, false);
    buffer.push(1100, 2, 2, false);
    expect(sampleAt(buffer, 900)).toEqual({ x: 1, z: 1, moving: false });
    expect(sampleAt(buffer, 5000)).toEqual({ x: 2, z: 2, moving: false });
  });

  it('刚起步和快停下的那一段也算在移动', () => {
    const buffer = new SnapshotBuffer();
    buffer.push(1000, 0, 0, false);
    buffer.push(1100, 0.6, 0, true);
    buffer.push(1200, 1, 0, false);
    expect(sampleAt(buffer, 1050)?.moving).toBe(true);
    expect(sampleAt(buffer, 1150)?.moving).toBe(true);
    expect(sampleAt(buffer, 1200)?.moving).toBe(false);
  });

  it('时间没有前进的快照覆盖最后一个，而不是乱序插入', () => {
    const buffer = new SnapshotBuffer();
    buffer.push(1000, 0, 0, false);
    buffer.push(1100, 5, 0, true);
    buffer.push(1050, 9, 9, false);
    expect(sampleAt(buffer, 1100)).toEqual({ x: 9, z: 9, moving: false });
    expect(sampleAt(buffer, 1050)).toEqual({ x: 4.5, z: 4.5, moving: true });
  });

  it('只保留最近的一段快照', () => {
    const buffer = new SnapshotBuffer();
    for (let i = 0; i < 100; i++) buffer.push(i * 100, i, 0, true);
    // 最早的已经被丢掉，取很早的时间会落在仍保留的第一个快照上。
    expect(sampleAt(buffer, 0)?.x).toBe(68);
    expect(sampleAt(buffer, 9850)?.x).toBe(98.5);
  });
});
