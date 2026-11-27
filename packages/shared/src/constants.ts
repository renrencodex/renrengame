/** 地图边长（世界单位）。可行走网格每格 1×1。 */
export const MAP_SIZE = 256;
/** 地图中心这个半径内不生成障碍物，留作出生点。 */
export const SPAWN_CLEAR_RADIUS = 14;
/** 新玩家出生在地图中心这个半径内。 */
export const SPAWN_RADIUS = 10;

/** 服务端每秒模拟的 tick 数。 */
export const TICK_RATE = 20;
export const TICK_MS = 1000 / TICK_RATE;
/** 每隔几个 tick 下发一次快照（2 即每秒 10 次）。 */
export const SNAPSHOT_EVERY_TICKS = 2;

/** 移动速度（单位/秒）。 */
export const MOVE_SPEED = 6;

/** AOI 格子边长。每个玩家能看到自己所在格和周围 8 格。 */
export const AOI_CELL_SIZE = 32;

/** 客户端渲染其他玩家时落后服务器的时间，用来在两个快照之间插值。 */
export const INTERP_DELAY_MS = 150;

/** 服务端接受的 moveTo 最远距离。 */
export const MAX_MOVE_DISTANCE = 60;
/** 客户端允许点击的最远距离。比服务端略小，因为服务端的位置比本地预测稍慢。 */
export const CLIENT_MOVE_DISTANCE = 56;
/** 同一玩家两次寻路的最小间隔。 */
export const MOVE_MIN_INTERVAL_MS = 100;
/** 每个 tick 最多做几次寻路，超出的排到后面的 tick。 */
export const MAX_PATHFINDS_PER_TICK = 16;
/** 单次 A* 最多展开的格子数，超出视为找不到路。 */
export const MAX_PATH_EXPANSIONS = 4000;

/** 服务端位置偏离本地预测轨迹超过这个距离时，客户端改为跟随服务端。 */
export const CORRECTION_THRESHOLD = 1.5;

// ---- 战斗 ----

export const PLAYER_MAX_HP = 100;
export const PLAYER_ATTACK_DAMAGE = 12;
export const PLAYER_ATTACK_INTERVAL_MS = 800;
/** 近战能打到的最远距离，由服务端判定。 */
export const ATTACK_RANGE = 2;
/** 客户端追到这个距离内就停下来打。比 ATTACK_RANGE 小，给服务端位置的滞后留余量。 */
export const CLIENT_ATTACK_RANGE = 1.5;
/** 玩家倒地后过这么久在出生点复活。 */
export const PLAYER_RESPAWN_MS = 5000;
/** 这么久没有打人也没有挨打，才开始回血。 */
export const REGEN_DELAY_MS = 6000;
/** 回血速度（点/秒）。 */
export const REGEN_PER_SECOND = 4;

/** 出生点周围这个半径内是安全区：怪物不进来，也不会攻击里面的玩家。 */
export const SAFE_ZONE_RADIUS = SPAWN_CLEAR_RADIUS;

// ---- 怪物 ----

export const MONSTER_COUNT = 120;
export const MONSTER_NAME = '行尸';
export const MONSTER_MAX_HP = 60;
export const MONSTER_ATTACK_DAMAGE = 8;
export const MONSTER_ATTACK_INTERVAL_MS = 1500;
/** 比玩家慢（MOVE_SPEED），打不过可以跑掉。 */
export const MONSTER_SPEED = 3.5;
/** 玩家进入这个距离，怪物就会追上来。 */
export const MONSTER_AGGRO_RADIUS = 8;
/** 目标离怪物超过这个距离，怪物放弃追击。 */
export const MONSTER_LOSE_RADIUS = 16;
/** 怪物离出生位置超过这个距离就放弃追击回家。回家途中不受伤害，到家回满血。 */
export const MONSTER_LEASH_RADIUS = 24;
/** 怪物追到离目标这么近就站住。 */
export const MONSTER_STOP_DISTANCE = 1.2;
/** 怪物死后尸体保留的时间。 */
export const MONSTER_CORPSE_MS = 3000;
/** 怪物死后过这么久在出生位置重生。 */
export const MONSTER_RESPAWN_MS = 20000;
/** 每只怪物每隔这么久做一次决策（找目标、重新寻路）。 */
export const MONSTER_THINK_MS = 200;
/** 每个 tick 所有怪物加起来最多寻路几次，和玩家的寻路上限分开算。 */
export const MAX_MONSTER_PATHFINDS_PER_TICK = 8;

export const MAX_NAME_LENGTH = 16;
export const SERVER_PORT = 8080;
export const WS_PATH = '/ws';
export const API_PATH = '/api';

/** 账号名的长度范围（按字符数）。目前账号名同时是角色名。 */
export const USERNAME_MIN_LENGTH = 2;
export const USERNAME_MAX_LENGTH = MAX_NAME_LENGTH;
export const PASSWORD_MIN_LENGTH = 6;
export const PASSWORD_MAX_LENGTH = 72;
/** 登录后拿到的会话令牌的最大长度。 */
export const MAX_TOKEN_LENGTH = 128;

// WebSocket 关闭码，4000–4999 是留给应用自定义的范围。
/** 在线人数已满（标准码 1013：稍后重试）。 */
export const CLOSE_SERVER_FULL = 1013;
/** 令牌无效或已过期，需要重新登录。 */
export const CLOSE_AUTH_FAILED = 4001;
/** 同一个账号在别处进入了游戏，这个连接被顶掉。 */
export const CLOSE_REPLACED = 4002;
