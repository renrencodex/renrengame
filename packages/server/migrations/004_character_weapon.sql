-- 角色手里拿的武器（物品名，比如 'sword'），空手是 NULL。拿在手里的那一件不算在 items 里。
ALTER TABLE characters ADD COLUMN weapon text;
