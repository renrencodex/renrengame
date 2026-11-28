import { attackDamage, ITEM_IDS, ITEMS, PLAYER_MAX_HP, POTION_COOLDOWN_MS } from '@mmo/shared';
import type { GameMap, Inventory, ItemId } from '@mmo/shared';
import { BagPanel } from './bag';
import { Minimap } from './minimap';
import { ShopPanel } from './shop';
import { itemIcon, uiIcon, uiText } from './ui';
import type { PlayerPortrait } from './ui';

export interface HudData {
  rtt: number;
  /** 视野内的玩家数（包括自己）和怪物数。 */
  players: number;
  monsters: number;
  x: number;
  z: number;
  yaw: number;
  /** 本地预测被服务端纠正的次数。 */
  corrections: number;
}

const UPDATE_MS = 500;

/** 自己和当前目标共用血条结构，生命值由快照决定。 */
class UnitFrame {
  readonly element = document.createElement('section');
  readonly portrait = document.createElement('div');
  readonly name = uiText('unit-name', '');
  readonly details = document.createElement('div');
  private readonly bar = document.createElement('div');
  private readonly fill = document.createElement('span');
  private readonly value = uiText('unit-health-value', '');
  private hp = -1;
  private maxHp = -1;

  constructor(kind: 'player' | 'target', label: string) {
    this.element.className = `unit-frame unit-${kind}`;
    this.element.setAttribute('aria-label', label);
    this.portrait.className = 'unit-portrait';
    this.portrait.setAttribute('aria-hidden', 'true');
    this.details.className = 'unit-details';
    this.bar.className = 'unit-health';
    this.bar.setAttribute('role', 'meter');
    this.bar.setAttribute('aria-label', '生命值');
    this.bar.setAttribute('aria-valuemin', '0');
    this.fill.className = 'unit-health-fill';
    this.bar.append(this.fill, this.value);
    this.details.append(this.name, this.bar);
    this.element.append(this.portrait, this.details);
  }

  setHp(hp: number, maxHp: number): void {
    if (hp === this.hp && maxHp === this.maxHp) return;
    this.hp = hp;
    this.maxHp = maxHp;
    const ratio = maxHp > 0 ? Math.min(1, Math.max(0, hp / maxHp)) : 0;
    this.fill.style.width = `${Math.round(ratio * 100)}%`;
    this.value.textContent = `${hp} / ${maxHp}`;
    this.bar.setAttribute('aria-valuenow', String(Math.min(maxHp, Math.max(0, hp))));
    this.bar.setAttribute('aria-valuemax', String(maxHp));
    this.element.classList.toggle('critical', ratio <= 0.25);
  }
}

/** 状态框、动作栏、小地图和窗口。所有操作同时提供屏幕按钮，输入仍由 Game 处理。 */
export class Hud {
  onUsePotion: (() => void) | null = null;
  onEquip: ((item: ItemId) => void) | null = null;
  onUnequip: (() => void) | null = null;
  onBuy: ((item: ItemId, count: number) => void) | null = null;
  onSell: ((item: ItemId, count: number) => void) | null = null;
  onToggleSound: (() => void) | null = null;
  onPanelSound: (() => void) | null = null;
  private readonly player = new UnitFrame('player', '角色状态');
  private readonly target = new UnitFrame('target', '当前目标');
  private readonly minimap = new Minimap();
  private readonly bag = new BagPanel();
  private readonly shop = new ShopPanel();
  private readonly statusValues = [
    uiText('stat-value', '—'),
    uiText('stat-value', '—'),
    uiText('stat-value', '—'),
    uiText('stat-value', '—'),
    uiText('stat-value', '—'),
  ];
  private readonly gold = uiText('hud-gold-count', '0');
  private readonly weaponIcon = document.createElement('span');
  private readonly weaponName = uiText('hud-weapon-name', '');
  private readonly weaponPower = uiText('hud-weapon-power', '');
  private readonly potionButton = document.createElement('button');
  private readonly potionCount = uiText('hud-potion-count', '0');
  private readonly potionSeconds = uiText('hud-potion-seconds', '');
  private readonly bagButton = document.createElement('button');
  private readonly soundButton = document.createElement('button');
  private readonly soundLabel = uiText('hud-action-label', '');
  private readonly bannerText = uiText('banner-text', '');
  private frames = 0;
  private lastUpdate = 0;
  private potions = 0;
  private hasIdleWeapon = false;
  private potionReadyAt = 0;
  private cooldownShown = -1;

  constructor(
    private readonly el: HTMLElement,
    private readonly banner: HTMLElement,
  ) {
    const gold = document.createElement('div');
    gold.className = 'hud-gold';
    gold.title = ITEMS.gold.name;
    gold.append(itemIcon('gold'), this.gold);
    this.player.details.append(gold);
    this.target.portrait.dataset.portrait = 'monster';
    this.target.element.hidden = true;
    const frames = document.createElement('div');
    frames.className = 'hud-units';
    frames.append(this.player.element, this.target.element);

    const dock = document.createElement('div');
    dock.className = 'hud-dock';
    const weapon = document.createElement('div');
    weapon.className = 'hud-weapon';
    this.weaponIcon.className = 'hud-weapon-icon';
    const weaponInfo = document.createElement('div');
    weaponInfo.className = 'hud-weapon-info';
    weaponInfo.append(this.weaponName, this.weaponPower);
    weapon.append(this.weaponIcon, weaponInfo);

    const actions = document.createElement('div');
    actions.className = 'hud-actions';
    actions.setAttribute('role', 'group');
    actions.setAttribute('aria-label', '快捷操作');

    this.potionButton.type = 'button';
    this.potionButton.className = 'hud-button hud-potion';
    this.potionButton.title = '喝一瓶治疗药水（1 键）';
    this.potionButton.setAttribute('aria-keyshortcuts', '1');
    this.potionButton.append(
      itemIcon('potion'),
      this.potionSeconds,
      this.potionCount,
      keyHint('1'),
      uiText('hud-action-label', '药水'),
    );
    this.potionButton.addEventListener('click', () => this.onUsePotion?.());

    this.bagButton.type = 'button';
    this.bagButton.className = 'hud-button hud-bag';
    this.bagButton.title = '打开或关上背包（B 键）';
    this.bagButton.setAttribute('aria-controls', 'bag-panel');
    this.bagButton.setAttribute('aria-keyshortcuts', 'B');
    this.bagButton.append(uiIcon('bag'), keyHint('B'), uiText('hud-action-label', '背包'));
    this.bagButton.addEventListener('click', () => this.toggleBag());

    this.soundButton.type = 'button';
    this.soundButton.className = 'hud-button hud-sound';
    this.soundButton.setAttribute('aria-keyshortcuts', 'M');
    this.soundButton.append(
      uiIcon('sound', 'sound-on-icon'),
      uiIcon('mute', 'sound-off-icon'),
      keyHint('M'),
      this.soundLabel,
    );
    this.soundButton.addEventListener('click', () => this.toggleSound());
    this.setSoundOn(true);
    actions.append(this.potionButton, this.bagButton, this.soundButton);
    dock.append(weapon, actions);

    const status = document.createElement('div');
    status.className = 'hud-status';
    const statLabels = ['延迟', '视野', '坐标', '纠正', 'FPS'];
    for (const [index, label] of statLabels.entries()) {
      const stat = document.createElement('span');
      stat.className = 'hud-stat';
      stat.append(uiText('stat-label', label), this.statusValues[index]);
      status.append(stat);
    }

    this.bag.onUse = (item) => {
      if (item === 'potion') this.onUsePotion?.();
    };
    this.bag.onEquip = (item) => this.onEquip?.(item);
    this.bag.onUnequip = () => this.onUnequip?.();
    this.bag.onClose = () => this.closeBag();
    this.shop.onBuy = (item, count) => this.onBuy?.(item, count);
    this.shop.onSell = (item, count) => this.onSell?.(item, count);
    this.shop.onClose = () => this.closeShop();

    const panelLayer = document.createElement('div');
    panelLayer.className = 'hud-panel-layer';
    const panels = document.createElement('div');
    panels.className = 'hud-panels';
    panels.append(this.shop.element, this.bag.element);
    panelLayer.append(panels);

    this.banner.setAttribute('role', 'status');
    this.banner.append(uiIcon('skull'), this.bannerText);
    el.replaceChildren(frames, this.minimap.element, dock, panelLayer, status);
    this.setPlayer('冒险者', 'male');
    this.setHp(0, PLAYER_MAX_HP);
    this.setInventory({}, null);
  }

  /** 窗口开着时由 HUD 拦住点偏的触摸，避免角色跑开。 */
  private syncPanels(): void {
    this.el.classList.toggle('panel-open', this.bag.open || this.shop.open);
    this.bagButton.classList.toggle('open', this.bag.open);
    this.bagButton.classList.toggle('notice', this.hasIdleWeapon && !this.bag.open);
    this.bagButton.setAttribute('aria-expanded', String(this.bag.open));
  }

  show(): void {
    this.el.hidden = false;
  }

  hide(): void {
    this.el.hidden = true;
  }

  setMap(map: GameMap): void {
    this.minimap.setMap(map);
  }

  setPlayer(name: string, portrait: PlayerPortrait): void {
    this.player.name.textContent = name;
    this.player.portrait.dataset.portrait = portrait;
  }

  setHp(hp: number, maxHp: number): void {
    this.player.setHp(hp, maxHp);
  }

  showTarget(name: string, hp: number, maxHp: number): void {
    this.target.name.textContent = name;
    this.setTargetHp(hp, maxHp);
    this.target.element.hidden = false;
  }

  setTargetHp(hp: number, maxHp: number): void {
    this.target.setHp(hp, maxHp);
  }

  hideTarget(): void {
    this.target.element.hidden = true;
  }

  setInventory(items: Inventory, weapon: ItemId | null): void {
    this.gold.textContent = String(items.gold ?? 0);
    this.potions = items.potion ?? 0;
    this.potionCount.textContent = String(this.potions);
    this.potionButton.classList.toggle('empty', this.potions === 0);
    this.potionButton.setAttribute('aria-label', `使用治疗药水，剩余 ${this.potions} 瓶`);
    this.weaponIcon.replaceChildren(weapon ? itemIcon(weapon) : uiIcon('fist'));
    this.weaponName.textContent = weapon ? ITEMS[weapon].name : '空手';
    this.weaponPower.textContent = `攻击力 ${attackDamage(weapon)}`;
    this.bag.setInventory(items, weapon);
    this.shop.setInventory(items);
    // 背包里有武器但还没装备时，给背包槽一个小金色标记。
    this.hasIdleWeapon = weapon === null && ITEM_IDS.some((id) => ITEMS[id].weapon && (items[id] ?? 0) > 0);
    this.syncPanels();
    this.updateCooldown(performance.now());
  }

  toggleBag(): void {
    if (this.bag.open) {
      this.closeBag();
      return;
    }
    this.bag.show();
    this.syncPanels();
    this.bag.element.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    this.onPanelSound?.();
  }

  closeBag(): void {
    if (!this.bag.open) return;
    const hadFocus = this.bag.element.contains(document.activeElement);
    this.bag.hide();
    this.syncPanels();
    if (hadFocus) this.bagButton.focus({ preventScroll: true });
    this.onPanelSound?.();
  }

  get shopOpen(): boolean {
    return this.shop.open;
  }

  openShop(): void {
    if (this.shop.open) return;
    this.shop.show();
    this.syncPanels();
    this.shop.element.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    this.onPanelSound?.();
  }

  closeShop(): void {
    if (!this.shop.open) return;
    this.shop.hide();
    this.syncPanels();
    this.onPanelSound?.();
  }

  closePanels(): void {
    if (!this.bag.open && !this.shop.open) return;
    const hadFocus = this.bag.element.contains(document.activeElement) || this.shop.element.contains(document.activeElement);
    this.bag.hide();
    this.shop.hide();
    this.syncPanels();
    if (hadFocus) this.bagButton.focus({ preventScroll: true });
    this.onPanelSound?.();
  }

  toggleSound(): void {
    this.onToggleSound?.();
  }

  setSoundOn(on: boolean): void {
    this.soundLabel.textContent = on ? '音效' : '静音';
    this.soundButton.classList.toggle('off', !on);
    this.soundButton.title = on ? '关掉声音（M 键）' : '打开声音（M 键）';
    this.soundButton.setAttribute('aria-label', '音效');
    this.soundButton.setAttribute('aria-pressed', String(on));
  }

  setPotionCooldown(readyAt: number): void {
    this.potionReadyAt = readyAt;
    this.updateCooldown(performance.now());
  }

  private updateCooldown(now: number): void {
    const left = this.potions > 0 ? Math.max(0, this.potionReadyAt - now) : 0;
    const percent = Math.min(100, Math.ceil((left / POTION_COOLDOWN_MS) * 100));
    if (percent !== this.cooldownShown) {
      this.cooldownShown = percent;
      this.potionButton.style.setProperty('--cooldown', `${percent}%`);
      this.potionButton.classList.toggle('cooling', left > 0);
      this.potionSeconds.textContent = left > 0 ? String(Math.ceil(left / 1000)) : '';
    }
    const disabled = this.potions === 0 || left > 0;
    if (this.potionButton.disabled !== disabled) this.potionButton.disabled = disabled;
  }

  setBanner(text: string | null): void {
    const next = text ?? '';
    if (next === this.bannerText.textContent) return;
    this.bannerText.textContent = next;
    this.banner.hidden = !next;
  }

  /** 地图自己节流重绘，诊断文字每半秒更新。 */
  frame(now: number, data: HudData): void {
    this.updateCooldown(now);
    this.minimap.update(now, data.x, data.z, data.yaw);
    this.frames++;
    const elapsed = now - this.lastUpdate;
    if (elapsed < UPDATE_MS) return;
    const fps = Math.round((this.frames * 1000) / elapsed);
    this.frames = 0;
    this.lastUpdate = now;
    const values = [
      `${Math.round(data.rtt)} ms`,
      `${data.players} 人 ${data.monsters} 怪`,
      `${data.x.toFixed(1)}, ${data.z.toFixed(1)}`,
      String(data.corrections),
      String(fps),
    ];
    for (const [index, value] of values.entries()) this.statusValues[index].textContent = value;
  }
}

function keyHint(key: string): HTMLElement {
  const hint = uiText('hud-key', key);
  hint.setAttribute('aria-hidden', 'true');
  return hint;
}
