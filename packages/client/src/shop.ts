import { buyProblem, ITEM_IDS, ITEMS, maxBuy, MERCHANT_NAME, POTION_HEAL, sellProblem, SHOP_GOODS } from '@mmo/shared';
import type { Inventory, ItemId, TradeProblem } from '@mmo/shared';
import { itemIcon } from './bag';

/** 按住 Shift 点击、或者打开了“一次 5 个”时，一次买卖这么多个（不够就有多少算多少）。 */
const BULK_COUNT = 5;

const PROBLEM_TEXT: Record<TradeProblem, string> = {
  invalid: '不能买',
  gold: '金币不够',
  full: '带满了',
  missing: '没有了',
};

/** 物品一句话的用处，显示在名字后面。 */
function describe(id: ItemId): string {
  const def = ITEMS[id];
  if (def.weapon) return `攻击力 +${def.weapon.damage}`;
  if (id === 'potion') return `回 ${POTION_HEAL} 血`;
  return '';
}

/** 商店里的一行。按钮只建一次，之后只改上面的字，这样连着点的时候不会因为重建而漏掉点击。 */
interface Row {
  button: HTMLButtonElement;
  count: HTMLElement;
  action: HTMLElement;
}

/**
 * 商店面板：上半部分是商人卖的东西，下半部分是背包里能卖给他的东西。
 * 点一下买卖一个；按住 Shift 点，或者先点亮标题旁边的“一次 5 个”（手机上没有 Shift），是五个。
 * 面板只负责显示和把点击告诉外面；买卖成不成由服务器决定，结果通过下一次 setInventory 反映出来。
 * 按钮能不能点用的是和服务器相同的规则（buyProblem、sellProblem），所以一般不会发出注定失败的请求。
 */
export class ShopPanel {
  readonly element = document.createElement('div');
  onBuy: ((item: ItemId, count: number) => void) | null = null;
  onSell: ((item: ItemId, count: number) => void) | null = null;
  /** 玩家点了关闭。 */
  onClose: (() => void) | null = null;
  private readonly buyRows = new Map<ItemId, Row>();
  private readonly sellRows = new Map<ItemId, Row>();
  private readonly nothingToSell = text('bag-empty', '背包里没有能卖的东西');
  private readonly bulkButton = document.createElement('button');
  private items: Inventory = {};
  /** “一次 5 个”是不是亮着。 */
  private bulk = false;

  constructor() {
    this.element.className = 'shop';
    this.element.hidden = true;

    const header = document.createElement('div');
    header.className = 'shop-header';
    this.bulkButton.type = 'button';
    this.bulkButton.className = 'shop-bulk';
    this.bulkButton.addEventListener('click', () => {
      this.bulkButton.blur();
      this.setBulk(!this.bulk);
    });
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'shop-close';
    close.title = '关上商店（Esc 键）';
    close.textContent = '×';
    close.addEventListener('click', () => this.onClose?.());
    header.append(text('shop-title', MERCHANT_NAME), this.bulkButton, close);
    this.setBulk(false);

    const buyList = document.createElement('div');
    buyList.className = 'bag-list';
    for (const id of SHOP_GOODS) {
      const row = this.createRow(id, 'buy', ITEMS[id].buyPrice as number, '买');
      row.button.addEventListener('click', (ev) => {
        row.button.blur();
        const count = ev.shiftKey || this.bulk ? Math.min(BULK_COUNT, maxBuy(this.items, id)) : 1;
        if (count >= 1 && buyProblem(this.items, id, count) === null) this.onBuy?.(id, count);
      });
      this.buyRows.set(id, row);
      buyList.append(row.button);
    }

    const sellList = document.createElement('div');
    sellList.className = 'bag-list';
    for (const id of ITEM_IDS) {
      const price = ITEMS[id].sellPrice;
      if (price === undefined) continue;
      const row = this.createRow(id, 'sell', price, '卖');
      row.button.addEventListener('click', (ev) => {
        row.button.blur();
        const count = ev.shiftKey || this.bulk ? Math.min(BULK_COUNT, this.items[id] ?? 0) : 1;
        if (count >= 1 && sellProblem(this.items, id, count) === null) this.onSell?.(id, count);
      });
      this.sellRows.set(id, row);
      sellList.append(row.button);
    }
    sellList.append(this.nothingToSell);

    this.element.append(
      header,
      text('bag-title', '买'),
      buyList,
      text('bag-title', '卖'),
      sellList,
      text('shop-hint', `按住 Shift 点击，一次 ${BULK_COUNT} 个`),
    );
    this.setInventory({});
  }

  get open(): boolean {
    return !this.element.hidden;
  }

  show(): void {
    this.element.hidden = false;
  }

  hide(): void {
    this.element.hidden = true;
    // 下次打开时回到一次一个，免得忘了它还亮着，一下买多了。
    this.setBulk(false);
  }

  private setBulk(on: boolean): void {
    this.bulk = on;
    this.bulkButton.textContent = `一次 ${on ? BULK_COUNT : 1} 个`;
    this.bulkButton.classList.toggle('on', on);
    this.bulkButton.title = on
      ? `现在点一下买卖 ${BULK_COUNT} 个，再点这里改回 1 个`
      : `点亮之后，点一下买卖 ${BULK_COUNT} 个`;
  }

  /** 背包变了：更新哪些买得起、哪些能卖、各有几个。 */
  setInventory(items: Inventory): void {
    this.items = items;
    for (const [id, row] of this.buyRows) {
      const problem = buyProblem(items, id, 1);
      row.button.disabled = problem !== null;
      row.action.textContent = problem ? PROBLEM_TEXT[problem] : '买';
    }
    let sellable = 0;
    for (const [id, row] of this.sellRows) {
      const count = items[id] ?? 0;
      row.button.hidden = count === 0;
      row.count.textContent = `×${count}`;
      // 金币到上限时卖不了；平时不会遇到，遇到了也要说明白。
      const problem = count > 0 ? sellProblem(items, id, 1) : null;
      row.button.disabled = problem !== null;
      row.action.textContent = problem ? PROBLEM_TEXT[problem] : '卖';
      if (count > 0) sellable++;
    }
    this.nothingToSell.hidden = sellable > 0;
  }

  private createRow(id: ItemId, kind: 'buy' | 'sell', price: number, action: string): Row {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `bag-row shop-row ${kind} ${id}`;
    const count = text('bag-count', '');
    const priceBox = document.createElement('span');
    priceBox.className = 'shop-price';
    priceBox.append(itemIcon('gold'), text('shop-price-number', String(price)));
    const actionLabel = text('bag-action', action);
    button.append(itemIcon(id), text('bag-name', ITEMS[id].name));
    // 买的那一行说明这东西有什么用，卖的那一行显示背包里有几个。
    if (kind === 'buy') button.append(text('bag-note', describe(id)));
    else button.append(count);
    button.append(priceBox, actionLabel);
    return { button, count, action: actionLabel };
  }
}

function text(className: string, content: string): HTMLElement {
  const el = document.createElement('span');
  el.className = className;
  el.textContent = content;
  return el;
}
