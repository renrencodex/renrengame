import { attackDamage, ITEM_IDS, ITEMS } from '@mmo/shared';
import type { Inventory, ItemId } from '@mmo/shared';

/** 一个物品的小图标，样式在 style.css 的 .item-icon 里。 */
export function itemIcon(item: ItemId): HTMLElement {
  const icon = document.createElement('span');
  icon.className = `item-icon ${item}`;
  return icon;
}

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
  private readonly weaponSlot = document.createElement('button');
  private readonly attack = document.createElement('div');
  private readonly list = document.createElement('div');

  constructor() {
    this.element.className = 'bag';
    this.element.hidden = true;

    this.weaponSlot.type = 'button';
    this.weaponSlot.addEventListener('click', () => {
      this.weaponSlot.blur();
      this.onUnequip?.();
    });
    this.attack.className = 'bag-attack';
    this.list.className = 'bag-list';

    this.element.append(title('武器'), this.weaponSlot, this.attack, title('背包'), this.list);
    this.setInventory({}, null);
  }

  get open(): boolean {
    return !this.element.hidden;
  }

  toggle(): void {
    this.element.hidden = !this.element.hidden;
  }

  setInventory(items: Inventory, weapon: ItemId | null): void {
    this.weaponSlot.className = weapon ? 'bag-row weapon-slot' : 'bag-row weapon-slot empty';
    this.weaponSlot.disabled = weapon === null;
    this.weaponSlot.title = weapon ? '点击收回背包' : '';
    if (weapon) {
      const bonus = ITEMS[weapon].weapon?.damage ?? 0;
      this.weaponSlot.replaceChildren(
        itemIcon(weapon),
        text('bag-name', ITEMS[weapon].name),
        text('bag-note', `攻击力 +${bonus}`),
        text('bag-action', '卸下'),
      );
    } else {
      this.weaponSlot.replaceChildren(text('bag-name', '空手'));
    }
    this.attack.textContent = `攻击力 ${attackDamage(weapon)}`;

    const rows: HTMLElement[] = [];
    for (const id of ITEM_IDS) {
      const count = items[id] ?? 0;
      if (count > 0) rows.push(this.itemRow(id, count));
    }
    if (rows.length === 0) rows.push(text('bag-empty', '背包是空的'));
    this.list.replaceChildren(...rows);
  }

  /** 背包里的一行。武器和能用的物品是按钮，其他的（金币）只是显示。 */
  private itemRow(id: ItemId, count: number): HTMLElement {
    const def = ITEMS[id];
    const action = def.weapon ? '装备' : def.usable ? '使用' : null;
    const row = document.createElement(action ? 'button' : 'div');
    row.className = `bag-row ${id}`;
    row.append(itemIcon(id), text('bag-name', def.name), text('bag-count', `×${count}`));
    if (def.weapon) row.append(text('bag-note', `攻击力 +${def.weapon.damage}`));
    if (action) {
      const button = row as HTMLButtonElement;
      button.type = 'button';
      button.append(text('bag-action', action));
      button.addEventListener('click', () => {
        button.blur();
        if (def.weapon) this.onEquip?.(id);
        else this.onUse?.(id);
      });
    }
    return row;
  }
}

function title(label: string): HTMLElement {
  return text('bag-title', label);
}

function text(className: string, content: string): HTMLElement {
  const el = document.createElement('span');
  el.className = className;
  el.textContent = content;
  return el;
}
