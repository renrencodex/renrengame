const WARMUP_MS = 1800;
const WINDOW_MS = 1600;
const SLOW_FRAME_MS = 38;
const SLOW_WINDOWS = 3;
const SUSPENDED_MS = 3000;

/** 慢帧需要持续多个采样窗口才降档。单次加载卡顿、切回页面不会触发。 */
export class RenderQuality {
  private last = -Infinity;
  private started = 0;
  private windowStart = 0;
  private frames = 0;
  private slow = 0;
  private reduced = false;

  /** 只在需要重新分配缓冲区的一帧返回 true。刷新页面后会重新评估。 */
  update(now: number, visible: boolean): boolean {
    if (this.reduced) return false;
    const gap = now - this.last;
    this.last = now;
    if (!visible || gap > SUSPENDED_MS) {
      this.started = this.windowStart = now;
      this.frames = this.slow = 0;
      return false;
    }
    if (now - this.started < WARMUP_MS) {
      this.windowStart = now;
      return false;
    }
    this.frames++;
    const elapsed = now - this.windowStart;
    if (elapsed < WINDOW_MS) return false;
    this.slow = elapsed / this.frames > SLOW_FRAME_MS ? this.slow + 1 : 0;
    this.frames = 0;
    this.windowStart = now;
    this.reduced = this.slow >= SLOW_WINDOWS;
    return this.reduced;
  }
}
