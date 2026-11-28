import { ITEMS, POTION_HEAL } from '@mmo/shared';
import type { ItemId } from '@mmo/shared';

type UiIcon = ItemId | 'crest' | 'bag' | 'sound' | 'mute' | 'fist' | 'shop' | 'close' | 'skull';

export type PlayerPortrait = 'male' | 'female';

/** 创建一枚来自本地 SVG 精灵图的图标。 */
export function uiIcon(name: UiIcon, extraClass = ''): SVGSVGElement {
  const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  icon.classList.add('ui-icon', `ui-icon-${name}`);
  if (extraClass) icon.classList.add(extraClass);
  icon.setAttribute('viewBox', name === 'crest' ? '0 0 64 64' : name === 'close' ? '0 0 24 24' : '0 0 32 32');
  icon.setAttribute('aria-hidden', 'true');
  icon.setAttribute('focusable', 'false');

  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', `${import.meta.env.BASE_URL}ui/icons.svg#${name}`);
  icon.append(use);
  return icon;
}

export function itemIcon(item: ItemId): HTMLElement {
  const icon = document.createElement('span');
  icon.className = `item-icon ${item}`;
  icon.append(uiIcon(item));
  return icon;
}

export function itemNote(item: ItemId): string {
  const weapon = ITEMS[item].weapon;
  if (weapon) return `攻击力 +${weapon.damage}`;
  if (item === 'potion') return `恢复 ${POTION_HEAL} 点生命`;
  return '';
}

export function uiText(className: string, content: string): HTMLElement {
  const element = document.createElement('span');
  element.className = className;
  element.textContent = content;
  return element;
}
