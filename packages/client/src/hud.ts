export interface HudData {
  rtt: number;
  /** 视野内的玩家数（包括自己）和怪物数。 */
  players: number;
  monsters: number;
  x: number;
  z: number;
  /** 本地预测被服务端纠正的次数。 */
  corrections: number;
}

const UPDATE_MS = 500;

/** 左上角的状态信息（延迟、视野内数量、坐标、帧率）和自己的血条，以及屏幕中间的提示。 */
export class Hud {
  private readonly status = document.createElement('div');
  private readonly hpFill = document.createElement('div');
  private readonly hpText = document.createElement('span');
  private frames = 0;
  private lastUpdate = 0;
  private bannerText = '';

  constructor(
    private readonly el: HTMLElement,
    private readonly banner: HTMLElement,
  ) {
    this.status.className = 'hud-status';
    const bar = document.createElement('div');
    bar.className = 'hud-hp';
    this.hpFill.className = 'hud-hp-fill';
    this.hpText.className = 'hud-hp-text';
    bar.append(this.hpFill, this.hpText);
    el.replaceChildren(bar, this.status);
  }

  show(): void {
    this.el.hidden = false;
  }

  setHp(hp: number, maxHp: number): void {
    const ratio = maxHp > 0 ? Math.min(1, Math.max(0, hp / maxHp)) : 0;
    this.hpFill.style.width = `${Math.round(ratio * 100)}%`;
    this.hpText.textContent = `${hp} / ${maxHp}`;
  }

  /** 屏幕中间的提示文字，传 null 时隐藏。 */
  setBanner(text: string | null): void {
    const next = text ?? '';
    if (next === this.bannerText) return;
    this.bannerText = next;
    this.banner.textContent = next;
    this.banner.hidden = next === '';
  }

  /** 每帧调用一次，每半秒刷新一次文字。 */
  frame(now: number, data: HudData): void {
    this.frames++;
    const elapsed = now - this.lastUpdate;
    if (elapsed < UPDATE_MS) return;
    const fps = Math.round((this.frames * 1000) / elapsed);
    this.frames = 0;
    this.lastUpdate = now;
    this.status.textContent =
      `延迟 ${Math.round(data.rtt)} ms · 视野内 ${data.players} 人 ${data.monsters} 怪 · ` +
      `坐标 (${data.x.toFixed(1)}, ${data.z.toFixed(1)}) · 纠正 ${data.corrections} 次 · ${fps} FPS`;
  }
}
