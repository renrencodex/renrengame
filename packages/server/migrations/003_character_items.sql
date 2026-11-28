-- 角色的背包：每种物品的数量，比如 {"gold": 12, "potion": 2}。金币也是一种物品。
-- 和位置、血量存在同一行，一次写入要么都成功要么都不成功。
ALTER TABLE characters ADD COLUMN items jsonb NOT NULL DEFAULT '{}'::jsonb;
