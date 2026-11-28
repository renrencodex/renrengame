import { describe, expect, it } from 'vitest';
import { riverCentres } from '../src/river';

describe('河面流向', () => {
  it('把桥宽内的干格插值为连续河心，并延伸到图边', () => {
    const centres = riverCentres([null, { left: 3, right: 7 }, null, null, { left: 6, right: 10 }, null]);
    expect(Array.from(centres)).toEqual([5, 5, 6, 7, 8, 8]);
  });

  it('无水地图不会为着色器生成无效坐标', () => {
    expect(riverCentres([null, null])).toEqual(new Float32Array(2));
  });
});
