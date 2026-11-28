import { POTION_COOLDOWN_MS } from '@mmo/shared';

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

/**
 * 左上角的状态信息（延迟、视野内数量、坐标、帧率）、自己的血条、金币和药水，以及屏幕中间的提示。
 * 药水是一个按钮，点它和按数字键 1 一样。
 */
export class Hud {
  /** 玩家点了药水按钮。 */
  onUsePotion: (() => void) | null = null;
  private readonly status = document.createElement('div');
  private readonly hpFill = document.createElement('div');
  private readonly hpText = document.createElement('span');
  private readonly gold = document.createElement('span');
  private readonly potionButton = document.createElement('button');
  private readonly potionCount = document.createElement('span');
  private readonly potionCooldown = document.createElement('div');
  private frames = 0;
  private lastUpdate = 0;
  private bannerText = '';
  private potions = 0;
  /** 药水冷却结束的本地时间。 */
  private potionReadyAt = 0;
  private cooldownShown = -1;

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

    const items = document.createElement('div');
    items.className = 'hud-items';
    const goldBox = document.createElement('div');
    goldBox.className = 'hud-gold';
    goldBox.title = '金币';
    const goldIcon = document.createElement('span');
    goldIcon.className = 'hud-gold-icon';
    this.gold.className = 'hud-gold-count';
    goldBox.append(goldIcon, this.gold);

    this.potionButton.type = 'button';
    this.potionButton.className = 'hud-potion';
    this.potionButton.title = '喝一瓶治疗药水（数字键 1）';
    const potionIcon = document.createElement('span');
    potionIcon.className = 'hud-potion-icon';
    this.potionCount.className = 'hud-potion-count';
    const key = document.createElement('span');
    key.className = 'hud-key';
    key.textContent = '1';
    this.potionCooldown.className = 'hud-potion-cooldown';
    this.potionButton.append(this.potionCooldown, potionIcon, this.potionCount, key);
    this.potionButton.addEventListener('click', () => {
      // 不留焦点，免得之后按空格、回车又触发一次。
      this.potionButton.blur();
      this.onUsePotion?.();
    });
    items.append(goldBox, this.potionButton);

    el.replaceChildren(bar, items, this.status);
    this.setInventory(0, 0);
  }

  show(): void {
    this.el.hidden = false;
  }

  setHp(hp: number, maxHp: number): void {
    const ratio = maxHp > 0 ? Math.min(1, Math.max(0, hp / maxHp)) : 0;
    this.hpFill.style.width = `${Math.round(ratio * 100)}%`;
    this.hpText.textContent = `${hp} / ${maxHp}`;
  }

  setInventory(gold: number, potions: number): void {
    this.gold.textContent = String(gold);
    this.potions = potions;
    this.potionCount.textContent = `×${potions}`;
    this.potionButton.classList.toggle('empty', potions === 0);
  }

  /** 药水进入冷却，到 readyAt（本地时间）结束。 */
  setPotionCooldown(readyAt: number): void {
    this.potionReadyAt = readyAt;
  }

  /** 屏幕中间的提示文字，传 null 时隐藏。 */
  setBanner(text: string | null): void {
    const next = text ?? '';
    if (next === this.bannerText) return;
    this.bannerText = next;
    this.banner.textContent = next;
    this.banner.hidden = next === '';
  }

  /** 每帧调用一次。冷却的遮罩每帧更新，文字每半秒刷新一次。 */
  frame(now: number, data: HudData): void {
    // 遮罩从整个按钮那么高慢慢降到 0；按百分之一取整，没变化时不碰 DOM。
    const left = this.potions > 0 ? Math.max(0, this.potionReadyAt - now) : 0;
    const percent = Math.min(100, Math.ceil((left / POTION_COOLDOWN_MS) * 100));
    if (percent !== this.cooldownShown) {
      this.cooldownShown = percent;
      this.potionCooldown.style.height = `${percent}%`;
      this.potionButton.classList.toggle('cooling', percent > 0);
    }

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
