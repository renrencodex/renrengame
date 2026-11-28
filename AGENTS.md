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
2. 改了服务器、协议或同步逻辑，再跑一次机器人压测。输出里“快照里的未知实体”必须是 0，结尾的服务端统计里 `skippedTicks` 必须是 0。机器人会打怪、捡东西、捡到武器就装备、攒够金币去找商人，“命中”和“拾取”应该大于 0（剑掉得少，“装备武器”可能是 0）；机器人很多时它们几乎不会死，也不喝药水，分到的金币也不够买东西，这些要用很少的机器人（`--count 30 --duration 60`）、单测或者自己进游戏验证。
3. 改了客户端的画面或交互，单测覆盖不到。可以用无头 Chromium 打开页面检查，启动参数加 `--use-angle=swiftshader --enable-unsafe-swiftshader` 才有 WebGL。做不了就在回复里明确说画面没有验证过。改了状态栏、面板或输入，还要用手机的尺寸再看一遍（Playwright 的 `isMobile: true, hasTouch: true`，竖屏 390×844 和横屏 844×390）；双指要用 CDP 的 `Input.dispatchTouchEvent` 发两个触点。声音听不了，但可以检查“该响的时候响了哪个、多大音量”：页面加载前用 `addInitScript` 包一层 `AudioBufferSourceNode.prototype.start` 把每次播放记下来，按缓冲区的长度认出是哪个声音（各个声效的长度都不一样）。这台机器上的无头 Chromium 同一个进程同时只有一个页面能打开音频设备，要两个页面同时有声音就各开一个浏览器。声效好不好听只能靠人听，改了 `synth.ts` 的参数要在回复里说明没有听过。

新增逻辑时把测试放在对应包的 `test/` 目录，文件名以 `.test.ts` 结尾。

## 必须遵守的设计约定

**服务器权威**

- 客户端只发送意图（`moveTo`：想去哪，`target`：想打谁，`use`：想用哪种物品，`equip`、`unequip`：想拿起或收起哪件武器，`buy`、`sell`：想和商人买卖什么），位置、血量、背包、装备、金币等状态一律由服务器计算。不要加“客户端上报自己位置”“客户端上报造成了多少伤害”“客户端上报捡到了什么”这类消息。
- 每一种客户端消息都要在 `shared/src/protocol.ts` 的 `decodeClientMsg` 里严格校验字段类型和范围，校验不过就丢弃。

**追击由客户端驱动，服务端只判定伤害**

- 玩家的移动只有 `moveTo` 这一个入口。选中怪物后，是客户端（`client/src/targeting.ts`）不断发 `moveTo` 把角色带到怪物旁边、够近了再发一次 `moveTo` 到自己的位置停下。不要在服务器里加“替玩家追目标”的逻辑，那样客户端的本地预测就对不上了。
- 服务器的 `World.playerAttack` 只在“目标活着、玩家站定、距离不超过 `ATTACK_RANGE`、中间没有墙、冷却结束”时结算伤害。客户端停下的距离 `CLIENT_ATTACK_RANGE` 故意比 `ATTACK_RANGE` 小，给网络延迟留余量；改其中一个时要保持这个关系。
- 血量和死亡状态以快照为准。`hit` 消息只用来播放动作和伤害数字，发送缓冲积压时会和快照一样被丢掉，不要让任何状态依赖它。

**怪物和玩家是同一种实体**

- 怪物和玩家共用 id 空间、AOI、`enter`、`leave` 和快照。实体进出视野统一走 `World` 的 `addToView`、`removeFromView`，玩家复活、怪物尸体消失和重生都是用它们实现的“离开再进入”，没有专门的消息。
- 怪物 AI（`server/src/monsterAi.ts`）是同步的状态机，通过 `AiHost` 接口访问世界。怪物寻路有单独的每 tick 上限（`MAX_MONSTER_PATHFINDS_PER_TICK`），不占玩家的额度。
- 怪物用的是另一个寻路器，安全区里的格子在它眼里是障碍，所以怪物的任何路线都不会穿过安全区。安全区按格子判定（`World.inSafeZone`），判定玩家是否安全和怪物能不能走进去必须用同一个边界。

**角色之间没有碰撞，怪物之间只有软分离**

- 没有物理引擎。墙靠寻路绕开，角色互相可以穿过去。不要加“角色挡住角色”的硬碰撞：窄路口会被堵死，算好的路线会因为别人走动而失效。
- 怪物离得比 `MONSTER_SEPARATION_DISTANCE` 近时，由 `server/src/separation.ts` 在每个 tick 的怪物 AI 之后慢慢推开。它只挪位置，不改路径和 AI 状态，每次挪动都用怪物的寻路器检查视线，所以不会把怪物推进墙里或安全区里。
- 只有两种怪物会被推：正在走路的（不往前推，所以不会超过 `MONSTER_SPEED`；`MONSTER_SEPARATION_SPEED` 必须比 `MONSTER_SPEED` 小，被挤着的怪物才能走到目标跟前），和站在目标旁边打的（只绕着目标转，离目标的距离不变，否则它会被推出 `MONSTER_STOP_DISTANCE` 又走回来，来回抖）。闲着的怪物不推，因为它不会自己走回出生位置。
- 玩家不推怪物，也不会被推。玩家的位置客户端要预测，服务器在路径之外再挪它，客户端就会不断被纠正。
- 被推的怪物在快照里还是“站立”状态，客户端看到位置变了会自己播放跑步动作（`SnapshotBuffer.sample`）。所以分离必须能停下来：`separation.ts` 里该推的距离小于 `MIN_STEP` 就不推，改推力的算法时要保留“挤了很多只时最后都站住”这个单测。

**地上的物品和背包**

- 地上的物品（`Drop`）是第三种实体，和玩家、怪物共用 id 空间、AOI、`enter` 和 `leave`，但它不会动，**不出现在快照里**。`EntityInfo` 是 `CharacterInfo | DropInfo`，用到 `name`、`hp`、`state` 之前先按 `kind` 区分。
- 拾取没有客户端消息：`World.tick` 里每个活着的玩家检查脚边 `PICKUP_RADIUS` 内的物品（`server/src/drops.ts` 的小格子索引），捡到就移出视野。客户端点地上的物品只是发一次普通的 `moveTo`。
- 背包只有服务器能改，每次变化都把整个背包用 `inv` 发给玩家自己。客户端拿前后两次的背包比较，得出“捡到了什么”“是不是刚喝了药水”，不要为这些再加消息。`heal` 和 `hit` 一样只用来飘字，积压时会被丢掉。
- 加一种物品要改三处：`shared/src/items.ts` 的 `ITEMS`、`client/src/drops.ts` 的 `ITEM_LOOKS`，以及 `tools/models/build-items.mjs`（生成 `item_<物品名>.glb`；没有模型时客户端用小方块代替）。武器还要在 `ITEMS` 里写 `weapon`，在 `ITEM_LOOKS` 里写 `held`（拿在手里时的大小和握的位置）。想让商人卖它或者收它，在 `ITEMS` 里写价格，商店面板会自己多出一行。
- 背包存在 `characters.items` 这一列（JSON，比如 `{"gold": 12, "potion": 2}`），和位置、血量一起由 `CharacterStore` 写库。读出来要经过 `sanitizeInventory`，所以从 `ITEMS` 里删掉一种物品时，存档里的这种物品会在下次上线后消失。
- 掉什么、掉在哪用的是 `World` 构造函数的第二个参数（默认 `Math.random`）。单测里只要有怪物被打死，就传一个固定的函数进去，否则掉落的位置和拾取的时机每次都不一样。`dropLoot` 取随机数的顺序是固定的（金币数量、方向、金币的距离、药水、药水的距离、剑、剑的距离），单测按这个顺序给数；新增的掉落放在最后，否则已有的单测都要重排。

**武器和装备**

- 手里的武器不在背包里：`Player.weapon` 是单独的一个栏位，`World.equip` 把一件武器从背包挪到手上，`World.unequip` 挪回去（背包里这种武器已经放满时卸不下来）。数背包里的东西时不要把手里那件算进去，也不要漏掉它：客户端比较前后两次 `inv` 时是把手里的武器加回去再比的，这样装备、卸下不会被当成“捡到了一件”。
- `inv` 同时带着背包和手里的武器，只发给玩家自己。别的玩家通过 `enter`（`CharacterInfo.weapon`，空手和怪物没有这个字段）和 `weapon` 消息知道一个人拿着什么。`weapon` 消息和 `enter`、`leave` 一样不能丢，不要把它加进积压时丢弃的那一类。
- 攻击力只在 `shared/src/items.ts` 的 `attackDamage` 里算，服务器结算伤害和客户端显示攻击力用的是同一个函数。
- 捡到武器不会自动装备；死亡不掉武器，倒地时不能装备和卸下。
- 手里的武器存在 `characters.weapon` 这一列（空表示空手），读出来要经过 `sanitizeWeapon`。
- 客户端把武器模型挂在人物模型的 `Weapon_R` 节点下面（`tools/models/build.mjs` 生成的，在右手手心）：节点的 +Y 是剑身的方向，原点是握的位置。武器模型要剑身朝 +Y，握柄的位置用 `ITEM_LOOKS` 的 `held.grip` 对准。

**商人和买卖**

- 商人不是服务器的实体：他不会动，位置由 `shared/src/shop.ts` 的 `merchantPosition(地图大小)` 算出来，没有 id，不进 AOI、`enter`、`leave` 和快照。客户端自己在那个位置画一个人（`EntityView` 的 `kind: 'npc'`）和一块地毯。不要为了“让客户端知道商人在哪”加消息。
- 走到商人跟前是客户端发的普通 `moveTo`，服务器不知道“去找商人”这回事。服务器只在 `World.buy`、`World.sell` 里判定：活着、按服务器算的位置离商人不超过 `SHOP_RANGE`、通过 `buyProblem` / `sellProblem`。成了就发一次 `inv`，不成什么也不发；没有“买卖结果”这种消息，客户端也是从前后两次 `inv` 看出结果的。
- `buyProblem`、`sellProblem`、`maxBuy` 在 `shared/src/shop.ts`，服务器靠它们决定买卖成不成，客户端靠它们决定按钮能不能点、Shift 一次买几个。改规则只改这一处。
- 客户端打开商店的距离 `CLIENT_SHOP_RANGE` 故意比 `SHOP_RANGE` 小，和攻击距离是同一个道理；改其中一个时保持这个关系。商人的位置加上 `SHOP_RANGE` 必须还在出生点的空地（`SPAWN_CLEAR_RADIUS`）里面，这样不用判断中间有没有墙（`shared/test/shop.test.ts` 里有检查）。
- 价格写在 `ITEMS` 的 `buyPrice`（商人卖多少钱，没有就是不卖）和 `sellPrice`（商人收多少钱，没有就是不收）里。`sellPrice` 必须比 `buyPrice` 低，否则可以倒手刷金币。
- 一笔买卖要么全成要么不成，不会只买一部分。拿在手里的武器不在背包里，所以卖不掉，要先收回背包。

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

**手机和触摸**

- 鼠标和触摸走的是同一套指针事件。哪些算“按下”、哪些算“双指缩放”由 `client/src/gestures.ts` 的 `PointerGestures` 判断，它不碰 DOM，有单测。触摸的按下会晚 `TOUCH_PRESS_DELAY_MS` 才算数（很快抬起的轻点不用等），这是为了双指缩放时先落下的那根手指不被当成点击；鼠标没有这个延迟。
- 镜头远近只通过 `CameraRig.zoomBy` 改（滚轮和双指都走它）。画面比 `MIN_ASPECT` 窄时镜头按比例拉远，雾也要跟着变远（`WorldScene.setViewScale`），改其中一个时看一下另一个。拉远之后的实际距离有上限（`MAX_VIEW_DISTANCE`），再远画面上下就会超出服务器下发实体的范围。
- 每个操作都要有屏幕上的按钮，不能只有快捷键或者只有 Shift+点击。
- 触摸屏上的按钮大小、手机横屏的排布都写在 `style.css` 末尾的媒体查询里（`pointer: coarse`、`orientation: landscape`），不要在脚本里判断是不是手机。
- 背包或商店开着时 `#hud` 带 `panel-open`，整块拦住点击；没开时只有按钮那一行拦，其余地方点下去仍然是点地面。

**声效**

- 声效是合成的，没有音频文件。`client/src/synth.ts` 只做计算（每个声音是几层波形和噪声，参数在 `RECIPES`），不碰浏览器的接口，有单测；`client/src/sound.ts` 的 `SoundPlayer` 负责播放。加一种声音要改三处：`synth.ts` 的 `SOUND_IDS` 和 `RECIPES`、`sound.ts` 的 `MIX`（音量和音高浮动），然后在 `game.ts` 里触发。
- 不要为声音加消息。它们都从已有的消息和状态里推出来：攻击和挨打跟着 `hit`，自己喝药水、捡东西、买卖靠比较前后两次的背包（`inventorySound`），换武器跟着 `weapon`，倒下和复活看快照里的状态。`hit`、`heal` 积压时会被丢掉，那一下就没有声音，这是可以接受的。
- 和自己直接有关的声音用原本的音量，别人的经过 `Game.playAt` 按距离变小（`distanceVolume`），超过 `HEARING_DISTANCE` 不响。别人和怪物的脚步不响。
- 浏览器只允许在用户操作之后出声。`SoundPlayer` 在第一次点击或按键时才创建 `AudioContext`，静音时根本不创建；设备没在运行（还没操作过、页面在后台、被系统打断）时 `play` 直接返回，不要改成把声音排进去等恢复，那样它们会攒着一起响。
- 声音的开关要有按钮（状态栏的“音效”），不能只有 M 键。

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
- 单测里把几只怪物放得比 `MONSTER_SEPARATION_DISTANCE` 还近时，它们一开始追人就会被互相推开，位置不再是算好的那几个点。要精确的位置就把它们隔开放。
- 单测里要放障碍物时，在 `new World(map)` 之前改 `map.blocked`。`World` 在构造时为怪物复制了一份地图，之后再改，怪物看不到。
- 数据库和 Redis 可能和别的项目共用同一个实例。只操作 `DATABASE_URL` 指向的库和带 `mmo:` 前缀的键，不要停止或重启这些服务，不要执行 `DROP`、`TRUNCATE`、`FLUSHALL`。
- 测试时创建的账号用完要删掉。压测脚本的“机器人N”账号用的是公开的默认密码，只能出现在本地环境。
- `packages/client/public/models/` 里的人物模型是 `tools/models/build.mjs` 生成的，不要手工改。客户端按名字找模型里的材质（`Skin`、`Shirt`、`Pants`、`Boots`、`Hair`、`Eyes`）、节点（`Hair`、`Weapon_R`）和动作（`Idle_Loop`、`Jog_Fwd_Loop`、`Punch_Jab`、`Punch_Cross`、`Sword_Idle`、`Sword_Attack`、`Death01`），改脚本里的名字要同时改 `packages/client/src/entities.ts`。物品模型 `item_<物品名>.glb` 是 `tools/models/build-items.mjs` 生成的，客户端按文件名加载。重新生成的步骤和素材的来源、授权见 README 的“素材”。
- 存档只在角色进过世界之后才读：`CharacterStore.load` 对位置为空的角色返回 `null`，这时 `items` 列也不会被读。测试时想预先给角色放物品或武器，要把 `x`、`z` 一起填上。
- `packages/client/vite.config.ts` 的 `allowedHosts` 里放行了一个远程预览域名，换预览环境时要在这里加新的域名。
