import { ITEM_IDS, ITEMS, POTION_COOLDOWN_MS } from '@mmo/shared';
import type { Inventory, ItemId } from '@mmo/shared';
import { BagPanel, itemIcon } from './bag';
import { ShopPanel } from './shop';

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
 * 左上角的状态栏：自己的血条、金币、药水、背包，以及延迟、视野内数量、坐标、帧率；还有屏幕中间的提示。
 * 药水是一个按钮，点它和按数字键 1 一样；背包按钮（或者 B 键）打开下面的背包面板；音效按钮（或者 M 键）开关声音。
 * 所有操作都有按钮，没有键盘的手机也能用；按钮在触摸屏上的大小由 style.css 里的 (pointer: coarse) 决定。
 * 商店面板也在这里，什么时候打开、关上由 Game 决定（走到商人跟前、走远了）。
 */
export class Hud {
  /** 玩家想喝药水（点了药水按钮，或者在背包里点了药水）。 */
  onUsePotion: (() => void) | null = null;
  /** 玩家在背包里点了一件武器，想把它拿在手里。 */
  onEquip: ((item: ItemId) => void) | null = null;
  /** 玩家点了武器栏，想把手里的武器收回背包。 */
  onUnequip: (() => void) | null = null;
  /** 玩家在商店里点了买、卖。 */
  onBuy: ((item: ItemId, count: number) => void) | null = null;
  onSell: ((item: ItemId, count: number) => void) | null = null;
  /** 玩家想开关声音（点了音效按钮，或者按了 M）。开关之后由外面调用 setSoundOn 更新按钮。 */
  onToggleSound: (() => void) | null = null;
  /** 面板打开或者关上了，可以响一下。 */
  onPanelSound: (() => void) | null = null;
  private readonly shop = new ShopPanel();
  private readonly status = document.createElement('div');
  private readonly hpFill = document.createElement('div');
  private readonly hpText = document.createElement('span');
  private readonly gold = document.createElement('span');
  private readonly potionButton = document.createElement('button');
  private readonly potionCount = document.createElement('span');
  private readonly potionCooldown = document.createElement('div');
  private readonly bagButton = document.createElement('button');
  private readonly soundButton = document.createElement('button');
  private readonly soundLabel = document.createElement('span');
  private readonly bag = new BagPanel();
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
    goldBox.title = ITEMS.gold.name;
    this.gold.className = 'hud-gold-count';
    goldBox.append(itemIcon('gold'), this.gold);

    this.potionButton.type = 'button';
    this.potionButton.className = 'hud-button hud-potion';
    this.potionButton.title = '喝一瓶治疗药水（数字键 1）';
    this.potionCount.className = 'hud-potion-count';
    this.potionCooldown.className = 'hud-potion-cooldown';
    this.potionButton.append(this.potionCooldown, itemIcon('potion'), this.potionCount, keyHint('1'));
    this.potionButton.addEventListener('click', () => {
      // 不留焦点，免得之后按空格、回车又触发一次。
      this.potionButton.blur();
      this.onUsePotion?.();
    });

    this.bagButton.type = 'button';
    this.bagButton.className = 'hud-button hud-bag';
    this.bagButton.title = '打开或关上背包（B 键）';
    const bagLabel = document.createElement('span');
    bagLabel.textContent = '背包';
    this.bagButton.append(bagLabel, keyHint('B'));
    this.bagButton.addEventListener('click', () => {
      this.bagButton.blur();
      this.toggleBag();
    });

    this.soundButton.type = 'button';
    this.soundButton.className = 'hud-button hud-sound';
    this.soundButton.append(this.soundLabel, keyHint('M'));
    this.soundButton.addEventListener('click', () => {
      this.soundButton.blur();
      this.toggleSound();
    });
    this.setSoundOn(true);
    items.append(goldBox, this.potionButton, this.bagButton, this.soundButton);

    this.bag.onUse = (item) => {
      if (item === 'potion') this.onUsePotion?.();
    };
    this.bag.onEquip = (item) => this.onEquip?.(item);
    this.bag.onUnequip = () => this.onUnequip?.();
    this.shop.onBuy = (item, count) => this.onBuy?.(item, count);
    this.shop.onSell = (item, count) => this.onSell?.(item, count);
    this.shop.onClose = () => this.closeShop();

    // 两个面板放在同一个容器里：平时上下排，手机横屏时屏幕不够高，改成左右排（见 style.css）。
    const panels = document.createElement('div');
    panels.className = 'hud-panels';
    panels.append(this.bag.element, this.shop.element);

    el.replaceChildren(bar, items, panels, this.status);
    this.setInventory({}, null);
  }

  /**
   * 有面板开着时给状态栏加上 panel-open：这时整块都拦住点击（点偏了不会让角色走开），
   * 内容比屏幕高时可以上下滑。
   */
  private syncPanels(): void {
    this.el.classList.toggle('panel-open', this.bag.open || this.shop.open);
  }

  show(): void {
    this.el.hidden = false;
  }

  setHp(hp: number, maxHp: number): void {
    const ratio = maxHp > 0 ? Math.min(1, Math.max(0, hp / maxHp)) : 0;
    this.hpFill.style.width = `${Math.round(ratio * 100)}%`;
    this.hpText.textContent = `${hp} / ${maxHp}`;
  }

  /** 背包里的东西和手里的武器（空手是 null）。 */
  setInventory(items: Inventory, weapon: ItemId | null): void {
    this.gold.textContent = String(items.gold ?? 0);
    this.potions = items.potion ?? 0;
    this.potionCount.textContent = `×${this.potions}`;
    this.potionButton.classList.toggle('empty', this.potions === 0);
    this.bag.setInventory(items, weapon);
    this.shop.setInventory(items);
    // 背包里有武器、手里却空着的时候，让背包按钮亮起来提醒一下。
    const idleWeapon = weapon === null && ITEM_IDS.some((id) => ITEMS[id].weapon && (items[id] ?? 0) > 0);
    this.bagButton.classList.toggle('notice', idleWeapon && !this.bag.open);
  }

  toggleBag(): void {
    this.bag.toggle();
    this.bagButton.classList.toggle('open', this.bag.open);
    if (this.bag.open) this.bagButton.classList.remove('notice');
    this.syncPanels();
    this.onPanelSound?.();
  }

  get shopOpen(): boolean {
    return this.shop.open;
  }

  openShop(): void {
    if (this.shop.open) return;
    this.shop.show();
    this.syncPanels();
    this.onPanelSound?.();
  }

  closeShop(): void {
    if (!this.shop.open) return;
    this.shop.hide();
    this.syncPanels();
    this.onPanelSound?.();
  }

  toggleSound(): void {
    this.onToggleSound?.();
  }

  /** 音效按钮显示成开着还是关着。 */
  setSoundOn(on: boolean): void {
    this.soundLabel.textContent = on ? '音效' : '静音';
    this.soundButton.classList.toggle('off', !on);
    this.soundButton.title = on ? '关掉声音（M 键）' : '打开声音（M 键）';
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

/** 按钮上提示快捷键的小方块。 */
function keyHint(key: string): HTMLElement {
  const hint = document.createElement('span');
  hint.className = 'hud-key';
  hint.textContent = key;
  return hint;
}
