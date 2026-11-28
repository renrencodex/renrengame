export type UiIcon = 'crest' | 'gold' | 'potion' | 'bag' | 'sound' | 'mute' | 'sword' | 'shop' | 'close';

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
