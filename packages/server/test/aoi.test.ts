import { describe, expect, it } from 'vitest';
import { AoiGrid } from '../src/aoi';

describe('AoiGrid', () => {
  // 256 的地图按 32 划格，共 8×8 格。
  const cell = (cx: number, cz: number) => cz * 8 + cx;

  it('把坐标映射到格子，越界时夹到边缘', () => {
    const grid = new AoiGrid(256, 32);
    expect(grid.cols).toBe(8);
    expect(grid.cellAt(0, 0)).toBe(cell(0, 0));
    expect(grid.cellAt(31.9, 32)).toBe(cell(0, 1));
    expect(grid.cellAt(255.9, 255.9)).toBe(cell(7, 7));
    expect(grid.cellAt(-5, 300)).toBe(cell(0, 7));
  });

  it('视野是自己和周围的格子，角落只有 4 格', () => {
    const grid = new AoiGrid(256, 32);
    expect(grid.neighbors(cell(3, 3))).toHaveLength(9);
    expect(grid.neighbors(cell(0, 3))).toHaveLength(6);
    expect([...grid.neighbors(cell(0, 0))].sort((a, b) => a - b)).toEqual([cell(0, 0), cell(1, 0), cell(0, 1), cell(1, 1)]);
  });

  it('在同一格内移动不产生视野变化', () => {
    const grid = new AoiGrid(256, 32);
    grid.add(1, 40, 40);
    expect(grid.move(1, 60, 50)).toBeNull();
    expect(grid.cellOf(1)).toBe(cell(1, 1));
  });

  it('跨格时算出进入和离开视野的格子', () => {
    const grid = new AoiGrid(256, 32);
    grid.add(1, 100, 100); // 格子 (3, 3)
    const change = grid.move(1, 130, 100); // 格子 (4, 3)
    expect(change).not.toBeNull();
    expect(change!.from).toBe(cell(3, 3));
    expect(change!.to).toBe(cell(4, 3));
    expect(change!.entered.sort((a, b) => a - b)).toEqual([cell(5, 2), cell(5, 3), cell(5, 4)]);
    expect(change!.left.sort((a, b) => a - b)).toEqual([cell(2, 2), cell(2, 3), cell(2, 4)]);
    expect(grid.idsIn(cell(3, 3)).has(1)).toBe(false);
    expect(grid.idsIn(cell(4, 3)).has(1)).toBe(true);
  });

  it('移除实体后不再出现在格子里', () => {
    const grid = new AoiGrid(256, 32);
    grid.add(7, 10, 10);
    expect(grid.remove(7)).toBe(cell(0, 0));
    expect(grid.idsIn(cell(0, 0)).size).toBe(0);
    expect(grid.cellOf(7)).toBeUndefined();
    expect(grid.remove(7)).toBeUndefined();
    expect(grid.move(7, 100, 100)).toBeNull();
  });
});
