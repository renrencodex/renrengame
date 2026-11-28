/**
 * 触摸按下之后，等这么久才当成“按下”。两根手指很少同时落到屏幕上，
 * 不等的话，双指缩放时先落下的那根手指会被当成点击，角色就朝那边走了。
 * 很快抬起来的轻点不用等满，抬起的那一刻就算数。
 */
export const TOUCH_PRESS_DELAY_MS = 120;
/** 两指之间不到这么多像素时不算缩放，免得除出一个很大的倍数。 */
const MIN_PINCH_DISTANCE = 12;

export interface GestureHandlers {
  /** 鼠标或者一根手指按下。坐标是调用方传进来的那一套（这里用的是相对画布左上角的像素）。 */
  onPress(x: number, y: number): void;
  /** 按下之后拖动。 */
  onDrag(x: number, y: number): void;
  /** 按下结束了：抬起、被系统打断，或者第二根手指落下、改成了缩放。 */
  onRelease(): void;
  /** 双指捏合。factor 是镜头距离要乘的倍数：手指张开时小于 1（拉近），并拢时大于 1（拉远）。 */
  onZoom(factor: number): void;
}

/**
 * 把一个个指针事件归纳成“按下、拖动、松开”和“双指缩放”。
 * 不碰 DOM：谁按下、在哪、什么时候，都由调用方告诉它，所以可以脱离浏览器做单测。
 *
 * 规则：
 * - 鼠标按下立刻算按下；
 * - 触摸要等 TOUCH_PRESS_DELAY_MS，或者在那之前抬起（轻点），才算按下；
 * - 第二根手指落下就改成缩放，还没算数的那次按下作废，已经算数的立刻松开；
 * - 缩放过之后，要等所有手指都离开屏幕，才会再有新的按下。
 */
export class PointerGestures {
  private readonly points = new Map<number, { x: number; y: number }>();
  /** 刚落下、还没确定是不是双指缩放的那根手指。 */
  private pending: { id: number; at: number } | null = null;
  private pressedId: number | null = null;
  private pinch: { a: number; b: number; distance: number } | null = null;

  constructor(private readonly handlers: GestureHandlers) {}

  down(id: number, touch: boolean, x: number, y: number, now: number): void {
    this.points.set(id, { x, y });
    if (this.points.size === 1) {
      if (touch) this.pending = { id, at: now };
      else this.press(id);
      return;
    }
    // 第三根及以后的手指不管。
    if (this.points.size !== 2) return;
    this.pending = null;
    this.release();
    const [a, b] = [...this.points.keys()];
    this.pinch = { a, b, distance: this.distanceBetween(a, b) };
  }

  /** 这个指针是不是正按着。鼠标没按下时的移动非常频繁，调用方可以先问一下，省掉换算坐标。 */
  has(id: number): boolean {
    return this.points.has(id);
  }

  move(id: number, x: number, y: number): void {
    const point = this.points.get(id);
    if (!point) return;
    point.x = x;
    point.y = y;
    const pinch = this.pinch;
    if (pinch) {
      if (id !== pinch.a && id !== pinch.b) return;
      const distance = this.distanceBetween(pinch.a, pinch.b);
      if (distance >= MIN_PINCH_DISTANCE && pinch.distance >= MIN_PINCH_DISTANCE) {
        this.handlers.onZoom(pinch.distance / distance);
      }
      pinch.distance = distance;
      return;
    }
    if (this.pressedId === id) this.handlers.onDrag(x, y);
  }

  up(id: number): void {
    // 轻点：还没等到算数就抬起来了，这时候补上。
    if (this.pending?.id === id) {
      this.pending = null;
      this.press(id);
    }
    this.finish(id);
  }

  /** 被系统打断（比如来了通知、手势被浏览器拿走）。和抬起不同，还没算数的按下直接作废。 */
  cancel(id: number): void {
    if (this.pending?.id === id) this.pending = null;
    this.finish(id);
  }

  /** 每帧调用：手指落下够久、又没有第二根手指，就算按下。 */
  update(now: number): void {
    if (!this.pending || now - this.pending.at < TOUCH_PRESS_DELAY_MS) return;
    const id = this.pending.id;
    this.pending = null;
    this.press(id);
  }

  private press(id: number): void {
    const point = this.points.get(id);
    if (!point) return;
    this.pressedId = id;
    this.handlers.onPress(point.x, point.y);
  }

  private release(): void {
    if (this.pressedId === null) return;
    this.pressedId = null;
    this.handlers.onRelease();
  }

  private finish(id: number): void {
    if (this.pressedId === id) this.release();
    this.points.delete(id);
    if (this.pinch && (id === this.pinch.a || id === this.pinch.b)) this.pinch = null;
  }

  private distanceBetween(a: number, b: number): number {
    const p = this.points.get(a);
    const q = this.points.get(b);
    return p && q ? Math.hypot(p.x - q.x, p.y - q.y) : 0;
  }
}
