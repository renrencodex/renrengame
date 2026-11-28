import { describe, expect, it } from 'vitest';
import { PointerGestures, TOUCH_PRESS_DELAY_MS } from '../src/gestures';

/** 把回调记成一串文字，方便比较先后顺序。 */
function setup() {
  const log: string[] = [];
  const zooms: number[] = [];
  const gestures = new PointerGestures({
    onPress: (x, y) => log.push(`press ${x},${y}`),
    onDrag: (x, y) => log.push(`drag ${x},${y}`),
    onRelease: () => log.push('release'),
    onZoom: (factor) => {
      zooms.push(factor);
      log.push('zoom');
    },
  });
  return { gestures, log, zooms };
}

describe('PointerGestures：鼠标', () => {
  it('按下立刻算数，拖动和松开依次通知', () => {
    const { gestures, log } = setup();
    gestures.down(1, false, 10, 20, 0);
    expect(log).toEqual(['press 10,20']);
    gestures.move(1, 30, 40);
    gestures.up(1);
    expect(log).toEqual(['press 10,20', 'drag 30,40', 'release']);
  });

  it('没按下时的移动不算拖动', () => {
    const { gestures, log } = setup();
    gestures.move(1, 30, 40);
    gestures.up(1);
    expect(log).toEqual([]);
  });
});

describe('PointerGestures：单指', () => {
  it('手指落下后要等一小会儿才算按下', () => {
    const { gestures, log } = setup();
    gestures.down(1, true, 10, 20, 1000);
    gestures.update(1000 + TOUCH_PRESS_DELAY_MS - 1);
    expect(log).toEqual([]);
    gestures.update(1000 + TOUCH_PRESS_DELAY_MS);
    expect(log).toEqual(['press 10,20']);
    // 算数之后不会再来一次。
    gestures.update(1000 + TOUCH_PRESS_DELAY_MS * 3);
    gestures.move(1, 50, 60);
    gestures.up(1);
    expect(log).toEqual(['press 10,20', 'drag 50,60', 'release']);
  });

  it('很快抬起的轻点，在抬起时算一次按下再松开', () => {
    const { gestures, log } = setup();
    gestures.down(1, true, 10, 20, 1000);
    gestures.up(1);
    expect(log).toEqual(['press 10,20', 'release']);
    gestures.update(1000 + TOUCH_PRESS_DELAY_MS * 2);
    expect(log).toEqual(['press 10,20', 'release']);
  });

  it('等待期间手指挪动了，按的是挪动之后的位置', () => {
    const { gestures, log } = setup();
    gestures.down(1, true, 10, 20, 0);
    gestures.move(1, 14, 26);
    gestures.update(TOUCH_PRESS_DELAY_MS);
    expect(log).toEqual(['press 14,26']);
  });

  it('被系统打断时，还没算数的按下作废', () => {
    const { gestures, log } = setup();
    gestures.down(1, true, 10, 20, 0);
    gestures.cancel(1);
    gestures.update(TOUCH_PRESS_DELAY_MS * 2);
    expect(log).toEqual([]);
  });

  it('抬起之后再收到一次打断（浏览器接着发的 lostpointercapture），什么都不会发生', () => {
    const { gestures, log } = setup();
    gestures.down(1, true, 10, 20, 0);
    gestures.up(1);
    gestures.cancel(1);
    gestures.cancel(99);
    expect(log).toEqual(['press 10,20', 'release']);
  });

  it('抬起的事件丢了、只收到打断时，这根手指不会一直占着，下一次单指照常', () => {
    const { gestures, log } = setup();
    gestures.down(1, true, 10, 20, 0);
    gestures.update(TOUCH_PRESS_DELAY_MS);
    expect(gestures.has(1)).toBe(true);
    gestures.cancel(1);
    expect(gestures.has(1)).toBe(false);
    gestures.down(2, true, 30, 40, 1000);
    gestures.up(2);
    expect(log).toEqual(['press 10,20', 'release', 'press 30,40', 'release']);
  });

  it('已经按下之后被打断，算松开', () => {
    const { gestures, log } = setup();
    gestures.down(1, true, 10, 20, 0);
    gestures.update(TOUCH_PRESS_DELAY_MS);
    gestures.cancel(1);
    expect(log).toEqual(['press 10,20', 'release']);
  });
});

describe('PointerGestures：双指缩放', () => {
  it('第二根手指紧跟着落下时，不会有按下，只有缩放', () => {
    const { gestures, log, zooms } = setup();
    gestures.down(1, true, 100, 100, 0);
    gestures.down(2, true, 200, 100, 30);
    gestures.update(TOUCH_PRESS_DELAY_MS * 2);
    // 两指从相距 100 张开到 200：镜头距离减半。
    gestures.move(2, 300, 100);
    expect(zooms).toEqual([0.5]);
    // 再并拢到 50：距离变成 4 倍。
    gestures.move(1, 250, 100);
    expect(zooms).toEqual([0.5, 4]);
    gestures.up(1);
    gestures.up(2);
    expect(log).toEqual(['zoom', 'zoom']);
  });

  it('已经按下之后第二根手指才落下：先松开，再缩放', () => {
    const { gestures, log, zooms } = setup();
    gestures.down(1, true, 100, 100, 0);
    gestures.update(TOUCH_PRESS_DELAY_MS);
    gestures.down(2, true, 100, 200, 500);
    gestures.move(1, 100, 150);
    expect(log).toEqual(['press 100,100', 'release', 'zoom']);
    expect(zooms).toEqual([2]);
  });

  it('缩放时抬起一根手指，剩下的那根不会变成按下或拖动', () => {
    const { gestures, log } = setup();
    gestures.down(1, true, 100, 100, 0);
    gestures.down(2, true, 200, 100, 10);
    gestures.up(2);
    gestures.move(1, 150, 150);
    gestures.update(TOUCH_PRESS_DELAY_MS * 5);
    gestures.up(1);
    expect(log).toEqual([]);
  });

  it('所有手指都离开之后，下一次按下照常', () => {
    const { gestures, log } = setup();
    gestures.down(1, true, 100, 100, 0);
    gestures.down(2, true, 200, 100, 10);
    gestures.up(1);
    gestures.up(2);
    gestures.down(3, true, 40, 50, 1000);
    gestures.up(3);
    expect(log).toEqual(['press 40,50', 'release']);
  });

  it('两指几乎叠在一起时不缩放，分开之后从当前的间距算起', () => {
    const { gestures, zooms } = setup();
    gestures.down(1, true, 100, 100, 0);
    gestures.down(2, true, 104, 100, 10);
    gestures.move(2, 200, 100);
    expect(zooms).toEqual([]);
    gestures.move(2, 300, 100);
    expect(zooms).toEqual([0.5]);
  });

  it('第三根手指不影响前两根的缩放', () => {
    const { gestures, log, zooms } = setup();
    gestures.down(1, true, 100, 100, 0);
    gestures.down(2, true, 200, 100, 10);
    gestures.down(3, true, 500, 500, 20);
    gestures.move(3, 600, 600);
    expect(zooms).toEqual([]);
    gestures.move(2, 300, 100);
    expect(zooms).toEqual([0.5]);
    expect(log).toEqual(['zoom']);
  });
});
