CREATE TABLE accounts (
  id            integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  username      text NOT NULL,
  password_hash text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_login_at timestamptz
);

-- 账号名不区分大小写。
CREATE UNIQUE INDEX accounts_username_key ON accounts (lower(username));

-- 目前每个账号只有一个角色，角色名就是注册时的账号名。
CREATE TABLE characters (
  id         integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  account_id integer NOT NULL UNIQUE REFERENCES accounts (id) ON DELETE CASCADE,
  name       text NOT NULL,
  -- 最近一次保存的位置；还没进过游戏时为空。
  x          real,
  z          real,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((x IS NULL) = (z IS NULL))
);

CREATE UNIQUE INDEX characters_name_key ON characters (lower(name));
