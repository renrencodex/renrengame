-- 角色的血量。NULL 表示还没存过（按满血处理），0 表示下线时是死亡状态。
ALTER TABLE characters ADD COLUMN hp integer CHECK (hp IS NULL OR hp >= 0);
