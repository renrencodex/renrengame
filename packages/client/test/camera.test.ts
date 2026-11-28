import { describe, expect, it } from 'vitest';
import { CameraRig, narrowScreenScale } from '../src/camera';

/** CameraRig 只用它来监听滚轮，测试里用不到。 */
const dom = { addEventListener: () => {} } as unknown as HTMLElement;

/** 镜头离它盯着的那个点有多远。snapTo 之后镜头对准的是 (0, 0, 0)。 */
function distanceOf(rig: CameraRig): number {
  rig.snapTo(0, 0);
  return rig.camera.position.length();
}

/** 让镜头的平滑过渡走完。 */
function settle(rig: CameraRig): void {
  for (let i = 0; i < 200; i++) rig.update(0, 0, 0.05);
}

describe('narrowScreenScale', () => {
  it('宽屏和接近方形的画面不拉远', () => {
    expect(narrowScreenScale(16 / 9)).toBe(1);
    expect(narrowScreenScale(1)).toBe(1);
    expect(narrowScreenScale(0.8)).toBe(1);
  });

  it('画面越窄拉得越远，左右看到的范围保持不变', () => {
    expect(narrowScreenScale(0.4)).toBeCloseTo(2);
    // 看到的宽度正比于 距离 × 宽高比。
    const phone = 390 / 844;
    expect(narrowScreenScale(phone) * phone).toBeCloseTo(0.8);
  });

  it('宽高比不正常时当成不用拉远', () => {
    expect(narrowScreenScale(0)).toBe(1);
    expect(narrowScreenScale(Number.NaN)).toBe(1);
  });
});

describe('CameraRig', () => {
  it('竖屏时镜头比横屏远，转回横屏后恢复', () => {
    const rig = new CameraRig(dom, 16 / 9);
    const wide = distanceOf(rig);
    rig.resize(0.4);
    expect(distanceOf(rig)).toBeCloseTo(wide * 2);
    expect(rig.viewScale).toBeCloseTo(2);
    rig.resize(16 / 9);
    expect(distanceOf(rig)).toBeCloseTo(wide);
    expect(rig.viewScale).toBe(1);
  });

  it('zoomBy 小于 1 拉近、大于 1 拉远', () => {
    const rig = new CameraRig(dom, 16 / 9);
    const before = distanceOf(rig);
    rig.zoomBy(0.8);
    settle(rig);
    expect(distanceOf(rig)).toBeCloseTo(before * 0.8);
    rig.zoomBy(1.25);
    settle(rig);
    expect(distanceOf(rig)).toBeCloseTo(before);
  });

  it('竖屏时能拉到的最远距离比“横屏最远 × 竖屏倍数”近，免得看到视野外面', () => {
    const wide = new CameraRig(dom, 16 / 9);
    wide.zoomBy(1000);
    settle(wide);
    const wideFarthest = distanceOf(wide);

    const phone = 390 / 844;
    const tall = new CameraRig(dom, phone);
    const tallDefault = distanceOf(tall);
    tall.zoomBy(1000);
    settle(tall);
    const tallFarthest = distanceOf(tall);
    // 还是能比默认再拉远一些，但远不到横屏最远的那个倍数。
    expect(tallFarthest).toBeGreaterThan(tallDefault * 1.3);
    expect(tallFarthest).toBeLessThan(wideFarthest * narrowScreenScale(phone) * 0.9);
    expect(tallFarthest).toBeCloseTo(88);
  });

  it('横屏时拉到最远再转成竖屏，会收回到竖屏允许的最远处', () => {
    const rig = new CameraRig(dom, 16 / 9);
    rig.zoomBy(1000);
    settle(rig);
    rig.resize(390 / 844);
    settle(rig);
    expect(distanceOf(rig)).toBeCloseTo(88);
    // 之后还能正常拉近。
    rig.zoomBy(0.5);
    settle(rig);
    expect(distanceOf(rig)).toBeCloseTo(44);
  });

  it('拉近和拉远都有限度，不正常的倍数不起作用', () => {
    const rig = new CameraRig(dom, 16 / 9);
    rig.zoomBy(0.001);
    settle(rig);
    const nearest = distanceOf(rig);
    rig.zoomBy(0.5);
    settle(rig);
    expect(distanceOf(rig)).toBeCloseTo(nearest);

    rig.zoomBy(1000);
    settle(rig);
    const farthest = distanceOf(rig);
    expect(farthest).toBeGreaterThan(nearest);
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) rig.zoomBy(bad);
    settle(rig);
    expect(distanceOf(rig)).toBeCloseTo(farthest);
  });
});
