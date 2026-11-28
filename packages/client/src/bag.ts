import { attackDamage, ITEM_IDS, ITEMS } from '@mmo/shared';
import type { Inventory, ItemId } from '@mmo/shared';
import { itemIcon, itemNote, uiIcon, uiText } from './ui';

/**
 * 背包面板：上面是武器栏（手里拿着什么、现在的攻击力），下面列出背包里的东西。
 * 点背包里的武器是装备，点武器栏是卸下，点药水是喝掉。面板只负责显示和把点击告诉外面，
 * 能不能装备、能不能喝由服务器决定，结果通过下一次 setInventory 反映出来。
 */
export class BagPanel {
  readonly element = document.createElement('div');
  onUse: ((item: ItemId) => void) | null = null;
  onEquip: ((item: ItemId) => void) | null = null;
  onUnequip: (() => void) | null = null;
  onClose: (() => void) | null = null;
  private readonly weaponSlot = document.createElement('button');
  private readonly attack = document.createElement('div');
  private readonly list = document.createElement('div');

  constructor() {
    this.element.className = 'bag game-panel';
    this.element.id = 'bag-panel';
    this.element.hidden = true;
    this.element.setAttribute('role', 'dialog');
    this.element.setAttribute('aria-labelledby', 'bag-title');

    const header = document.createElement('div');
    header.className = 'panel-header';
    const heading = document.createElement('h2');
    heading.className = 'panel-title';
    heading.id = 'bag-title';
    heading.append(uiIcon('bag'), uiText('panel-title-text', '背包'));
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'panel-close';
    close.title = '关上背包（B 键）';
    close.setAttribute('aria-label', '关上背包');
    close.append(uiIcon('close'));
    close.addEventListener('click', () => this.onClose?.());
    header.append(heading, close);

    this.weaponSlot.type = 'button';
    this.weaponSlot.addEventListener('click', () => this.onUnequip?.());
    this.attack.className = 'bag-attack';
    this.list.className = 'bag-grid';

    this.element.append(header, sectionTitle('武器栏', this.attack), this.weaponSlot, sectionTitle('随身物品'), this.list);
    this.setInventory({}, null);
  }

  get open(): boolean {
    return !this.element.hidden;
  }

  show(): void {
    this.element.hidden = false;
  }

  hide(): void {
    this.element.hidden = true;
  }

  setInventory(items: Inventory, weapon: ItemId | null): void {
    this.weaponSlot.className = weapon ? 'weapon-slot' : 'weapon-slot empty';
    this.weaponSlot.disabled = weapon === null;
    this.weaponSlot.title = weapon ? '点击收回背包' : '';
    this.weaponSlot.setAttribute('aria-label', weapon ? `卸下${ITEMS[weapon].name}` : '武器栏为空');
    this.weaponSlot.replaceChildren(
      weapon ? itemIcon(weapon) : uiIcon('fist', 'weapon-empty-icon'),
      uiText('bag-name', weapon ? ITEMS[weapon].name : '空手'),
    );
    if (weapon) this.weaponSlot.append(uiText('bag-action', '卸下'));
    this.attack.textContent = `攻击力 ${attackDamage(weapon)}`;

    const cells: HTMLElement[] = [];
    for (const id of ITEM_IDS) {
      const count = items[id] ?? 0;
      if (count > 0) cells.push(this.itemCell(id, count));
    }
    if (cells.length === 0) cells.push(uiText('bag-empty', '背包是空的'));
    this.list.replaceChildren(...cells);
  }

  /** 武器和能用的物品是按钮，金币只显示数量。 */
  private itemCell(id: ItemId, count: number): HTMLElement {
    const def = ITEMS[id];
    const action = def.weapon ? '装备' : def.usable ? '使用' : null;
    const cell = document.createElement(action ? 'button' : 'div');
    const icon = itemIcon(id);
    icon.append(uiText('bag-count', `×${count}`));
    cell.className = `bag-cell ${id}`;
    cell.append(icon, uiText('bag-name', def.name));
    if (action) {
      const button = cell as HTMLButtonElement;
      const note = itemNote(id);
      button.type = 'button';
      button.setAttribute('aria-label', `${action}${def.name}，共 ${count} 件${note ? `，${note}` : ''}`);
      button.title = note;
      button.append(uiText('bag-cell-action', action));
      button.addEventListener('click', () => {
        if (def.weapon) this.onEquip?.(id);
        else this.onUse?.(id);
      });
    }
    return cell;
  }
}

function sectionTitle(label: string, trailing?: HTMLElement): HTMLElement {
  const title = document.createElement('div');
  title.className = 'bag-title';
  title.append(uiText('bag-title-text', label));
  if (trailing) title.append(trailing);
  return title;
}
