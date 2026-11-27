export interface HudData {
  rtt: number;
  visible: number;
  x: number;
  z: number;
  /** 本地预测被服务端纠正的次数。 */
  corrections: number;
}

const UPDATE_MS = 500;

/** 左上角的状态信息：延迟、视野内人数、坐标、帧率。 */
export class Hud {
  private frames = 0;
  private lastUpdate = 0;

  constructor(private readonly el: HTMLElement) {}

  show(): void {
    this.el.hidden = false;
  }

  /** 每帧调用一次，每半秒刷新一次文字。 */
  frame(now: number, data: HudData): void {
    this.frames++;
    const elapsed = now - this.lastUpdate;
    if (elapsed < UPDATE_MS) return;
    const fps = Math.round((this.frames * 1000) / elapsed);
    this.frames = 0;
    this.lastUpdate = now;
    this.el.textContent =
      `延迟 ${Math.round(data.rtt)} ms · 视野内 ${data.visible} 人 · ` +
      `坐标 (${data.x.toFixed(1)}, ${data.z.toFixed(1)}) · 纠正 ${data.corrections} 次 · ${fps} FPS`;
  }
}
