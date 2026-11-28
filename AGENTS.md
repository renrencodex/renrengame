# AGENTS.md

给在这个仓库里工作的 AI 编程助手看的说明。项目介绍和运行步骤在 `README.md`，这里只写改代码时需要知道、但从代码里不容易看出来的事。

## 项目是什么

2.5D 网页 MMO 原型，pnpm workspaces 单仓库，全部是 TypeScript：

- `packages/shared`：客户端和服务器共用的协议、常量和游戏规则。
- `packages/server`：权威游戏服务器（Node.js + `ws`），PostgreSQL 存账号和角色，Redis 存会话。
- `packages/client`：浏览器客户端（Three.js + Vite）。

## 命令

都在仓库根目录执行。

```bash
pnpm install
pnpm dev          # 服务器 (8080) + 客户端 (5173)
pnpm typecheck    # 三个包的类型检查
pnpm test         # Vitest，不需要数据库和 Redis
pnpm build        # 构建客户端
pnpm bots --count 50 --duration 15   # 机器人压测，需要服务器在运行
deploy/deploy.sh  # 把已提交的代码部署到本机（需要 root，见“线上环境”）
```

启动服务器需要 PostgreSQL、Redis 和 `packages/server/.env`（参考 `.env.example`）。

## 改完代码怎么验证

1. 每次都跑 `pnpm typecheck` 和 `pnpm test`。
2. 改了服务器、协议或同步逻辑，再跑一次机器人压测。输出里“快照里的未知实体”必须是 0，结尾的服务端统计里 `skippedTicks` 必须是 0。机器人会打怪和捡东西，“命中”和“拾取”应该大于 0；机器人很多时它们几乎不会死，也不喝药水，这些要用很少的机器人（`--count 30 --duration 60`）、单测或者自己进游戏验证。
3. 改了客户端的画面或交互，单测覆盖不到。可以用无头 Chromium 打开页面检查，启动参数加 `--use-angle=swiftshader --enable-unsafe-swiftshader` 才有 WebGL。做不了就在回复里明确说画面没有验证过。

新增逻辑时把测试放在对应包的 `test/` 目录，文件名以 `.test.ts` 结尾。

## 必须遵守的设计约定

**服务器权威**

- 客户端只发送意图（`moveTo`：想去哪，`target`：想打谁，`use`：想用哪种物品），位置、血量、背包等状态一律由服务器计算。不要加“客户端上报自己位置”“客户端上报造成了多少伤害”“客户端上报捡到了什么”这类消息。
- 每一种客户端消息都要在 `shared/src/protocol.ts` 的 `decodeClientMsg` 里严格校验字段类型和范围，校验不过就丢弃。

**追击由客户端驱动，服务端只判定伤害**

- 玩家的移动只有 `moveTo` 这一个入口。选中怪物后，是客户端（`client/src/targeting.ts`）不断发 `moveTo` 把角色带到怪物旁边、够近了再发一次 `moveTo` 到自己的位置停下。不要在服务器里加“替玩家追目标”的逻辑，那样客户端的本地预测就对不上了。
- 服务器的 `World.playerAttack` 只在“目标活着、玩家站定、距离不超过 `ATTACK_RANGE`、中间没有墙、冷却结束”时结算伤害。客户端停下的距离 `CLIENT_ATTACK_RANGE` 故意比 `ATTACK_RANGE` 小，给网络延迟留余量；改其中一个时要保持这个关系。
- 血量和死亡状态以快照为准。`hit` 消息只用来播放动作和伤害数字，发送缓冲积压时会和快照一样被丢掉，不要让任何状态依赖它。

**怪物和玩家是同一种实体**

- 怪物和玩家共用 id 空间、AOI、`enter`、`leave` 和快照。实体进出视野统一走 `World` 的 `addToView`、`removeFromView`，玩家复活、怪物尸体消失和重生都是用它们实现的“离开再进入”，没有专门的消息。
- 怪物 AI（`server/src/monsterAi.ts`）是同步的状态机，通过 `AiHost` 接口访问世界。怪物寻路有单独的每 tick 上限（`MAX_MONSTER_PATHFINDS_PER_TICK`），不占玩家的额度。
- 怪物用的是另一个寻路器，安全区里的格子在它眼里是障碍，所以怪物的任何路线都不会穿过安全区。安全区按格子判定（`World.inSafeZone`），判定玩家是否安全和怪物能不能走进去必须用同一个边界。

**地上的物品和背包**

- 地上的物品（`Drop`）是第三种实体，和玩家、怪物共用 id 空间、AOI、`enter` 和 `leave`，但它不会动，**不出现在快照里**。`EntityInfo` 是 `CharacterInfo | DropInfo`，用到 `name`、`hp`、`state` 之前先按 `kind` 区分。
- 拾取没有客户端消息：`World.tick` 里每个活着的玩家检查脚边 `PICKUP_RADIUS` 内的物品（`server/src/drops.ts` 的小格子索引），捡到就移出视野。客户端点地上的物品只是发一次普通的 `moveTo`。
- 背包只有服务器能改，每次变化都把整个背包用 `inv` 发给玩家自己。客户端拿前后两次的背包比较，得出“捡到了什么”“是不是刚喝了药水”，不要为这些再加消息。`heal` 和 `hit` 一样只用来飘字，积压时会被丢掉。
- 加一种物品要改三处：`shared/src/items.ts` 的 `ITEMS`、`client/src/drops.ts` 的 `ITEM_LOOKS`，以及 `tools/models/build-items.mjs`（生成 `item_<物品名>.glb`；没有模型时客户端用小方块代替）。
- 背包存在 `characters.items` 这一列（JSON，比如 `{"gold": 12, "potion": 2}`），和位置、血量一起由 `CharacterStore` 写库。读出来要经过 `sanitizeInventory`，所以从 `ITEMS` 里删掉一种物品时，存档里的这种物品会在下次上线后消失。
- 掉什么、掉在哪用的是 `World` 构造函数的第二个参数（默认 `Math.random`）。单测里只要有怪物被打死，就传一个固定的函数进去，否则掉落的位置和拾取的时机每次都不一样。

**共用的规则放在 shared**

- 地图生成、寻路、移动这些代码客户端预测和服务器模拟用的是同一份。只改一边会让客户端不断被服务器纠正。
- 协议的类型和编解码都集中在 `protocol.ts`，游戏参数集中在 `constants.ts`，物品的定义集中在 `items.ts`，不要在别处写死数字。
- `shared` 没有构建步骤，其他包直接引用它的 TypeScript 源码。

**游戏循环里不能等待 I/O**

- `World.tick` 及它调用的代码必须是同步的，不能访问数据库或 Redis。
- 要保存角色数据（位置、血量、背包）时，调用 `CharacterStore.markDirty` 记在内存里，由定时的 `flush` 批量写库。
- `World` 不依赖 `ws`、`pg`、`redis`，只通过 `Connection` 接口发消息；`CharacterStore` 只依赖 `Queryable` 接口。保持这一点，它们才能脱离外部服务做单测。

**进入世界的流程**

`server/src/index.ts` 的 `enter()` 里，读完会话和存档之后的那一段（检查是否已在线、顶号、`world.join`）中间没有 `await`，这样同一个账号的两个连接不会交错。往这一段里加异步操作会引入竞态。

**数据库**

- 改表结构时在 `packages/server/migrations/` 新增一个编号更大的 `.sql` 文件。已有的迁移文件不要改，它们在别的环境里已经执行过了。
- 查询一律用参数占位符（`$1`），不要拼接 SQL。

**账号和安全**

- 密码只存 scrypt 哈希，Redis 里只存会话令牌的哈希。不要把密码、令牌或连接串写进日志或错误信息。
- Redis 的键都要带 `redis.ts` 里的 `KEY_PREFIX`。
- 返回给客户端的错误信息不要包含内部细节，细节写服务器日志。

## 线上环境

这台开发机同时也是线上环境，改代码之前要知道：

- 线上版本是 systemd 服务 `renrengame`，代码在 `/opt/renrengame/current`（某个提交的副本），配置在 `/etc/renrengame/env`，监听 `[::1]:5173`，玩家通过预览域名访问。工作区里的改动不会影响它，直到执行 `deploy/deploy.sh`。
- **只有用户明确要求时才部署或重启线上服务。** 部署会让在线的玩家断线。
- 线上占用了 5173 端口，`pnpm dev` 的客户端会自动换到下一个端口；游戏服务器的开发端口还是 8080。
- 线上用的是 `mmo` 数据库的 `public` schema 和 Redis 的 0 号库，里面有真实玩家的账号。这台机器上的 `packages/server/.env` 已经改成开发专用：同一个库的 `dev` schema（连接串末尾的 `options=-c%20search_path%3Ddev`）和 Redis 的 1 号库。启动开发服务器、跑压测或测试脚本之前确认 `.env` 仍然是这样；用 `psql` 手工查数据时注意自己连的是哪个 schema。
- `deploy/deploy.sh` 生成 systemd 单元和配置文件；要改服务的运行方式就改脚本，不要手工改 `/etc/systemd/system/renrengame.service`，下次部署会被覆盖。

## 代码风格

- `tsconfig` 开了 `verbatimModuleSyntax`：只用作类型的导入必须写 `import type`。
- 开了 `noUnusedLocals` 和 `noUnusedParameters`，没用到的变量会让类型检查失败。
- 注释、日志和给玩家看的文案用中文。注释解释“为什么这样做”，不复述代码。
- 写日志里的错误信息用 `server/src/errors.ts` 的 `errorText`，连接失败时 `err.message` 经常是空的。

## 容易踩的坑

- **不要提交 `packages/server/.env`**，里面有数据库密码，已经在 `.gitignore` 里。
- `pnpm dev` 运行时，改动服务器或 `shared` 的文件会让服务器自动重启，在线的玩家会断线（位置、血量和背包会在关闭前保存），怪物全部重新生成，地上的物品消失。
- 单测里要放障碍物时，在 `new World(map)` 之前改 `map.blocked`。`World` 在构造时为怪物复制了一份地图，之后再改，怪物看不到。
- 数据库和 Redis 可能和别的项目共用同一个实例。只操作 `DATABASE_URL` 指向的库和带 `mmo:` 前缀的键，不要停止或重启这些服务，不要执行 `DROP`、`TRUNCATE`、`FLUSHALL`。
- 测试时创建的账号用完要删掉。压测脚本的“机器人N”账号用的是公开的默认密码，只能出现在本地环境。
- `packages/client/public/models/` 里的人物模型是 `tools/models/build.mjs` 生成的，不要手工改。客户端按名字找模型里的材质（`Skin`、`Shirt`、`Pants`、`Boots`、`Hair`、`Eyes`）、节点（`Hair`）和动作（`Idle_Loop`、`Jog_Fwd_Loop`、`Punch_Jab`、`Punch_Cross`、`Death01`），改脚本里的名字要同时改 `packages/client/src/entities.ts`。物品模型 `item_<物品名>.glb` 是 `tools/models/build-items.mjs` 生成的，客户端按文件名加载。重新生成的步骤和素材的来源、授权见 README 的“素材”。
- 存档只在角色进过世界之后才读：`CharacterStore.load` 对位置为空的角色返回 `null`，这时 `items` 列也不会被读。测试时想预先给角色放物品，要把 `x`、`z` 一起填上。
- `packages/client/vite.config.ts` 的 `allowedHosts` 里放行了一个远程预览域名，换预览环境时要在这里加新的域名。
