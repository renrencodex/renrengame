#!/usr/bin/env bash
#
# 把仓库里已经提交的代码部署到本机，作为 systemd 服务运行。
#
# 用法（需要 root）：
#   deploy/deploy.sh [git 引用]        默认部署 HEAD。没有提交的改动不会被部署。
#
# 做的事情：
#   1. 把指定的提交导出到 /opt/renrengame/releases/<时间>-<提交>，和开发目录完全分开；
#   2. 在里面安装依赖、跑类型检查和单测、构建客户端，任何一步失败都不会影响正在运行的版本；
#   3. 把 /opt/renrengame/current 指向新版本，重启服务；
#   4. 检查服务是否正常，不正常就切回上一个版本。
#
# 第一次运行时会创建 /etc/renrengame/env（数据库和 Redis 的连接信息、端口），
# 内容取自仓库里的 packages/server/.env。之后要改配置就直接改这个文件，再重启服务。
#
# 重启服务时在线的玩家会断线（位置和血量会先保存），怪物全部重新生成。

set -euo pipefail

SERVICE=renrengame
APP_DIR=/opt/renrengame
ENV_DIR=/etc/renrengame
ENV_FILE="$ENV_DIR/env"
UNIT_FILE="/etc/systemd/system/$SERVICE.service"
# 第一次部署时写进配置文件的默认值。
DEFAULT_PORT=5173
DEFAULT_HOST=::1
KEEP_RELEASES=3

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REF="${1:-HEAD}"

say() { printf '[deploy] %s\n' "$*"; }
die() { printf '[deploy] 失败：%s\n' "$*" >&2; exit 1; }
# 执行一条命令，成功时不输出，失败时把它的输出打印出来。
quiet() {
  local log
  log="$(mktemp)"
  if "$@" > "$log" 2>&1; then
    rm -f "$log"
  else
    cat "$log" >&2
    rm -f "$log"
    return 1
  fi
}

[ "$(id -u)" -eq 0 ] || die "需要用 root 运行。"
for cmd in git node pnpm curl systemctl ss; do
  command -v "$cmd" >/dev/null || die "找不到命令 $cmd。"
done

commit="$(git -C "$REPO_DIR" rev-parse --verify --quiet "$REF^{commit}")" || die "找不到提交 $REF。"
short="$(git -C "$REPO_DIR" rev-parse --short "$commit")"
if [ -n "$(git -C "$REPO_DIR" status --porcelain)" ]; then
  say "注意：工作区有没提交的改动，它们不会被部署。"
fi

# ---- 配置文件 ----

if [ ! -f "$ENV_FILE" ]; then
  source_env="$REPO_DIR/packages/server/.env"
  [ -f "$source_env" ] || die "没有 $ENV_FILE，也没有 $source_env 可以用来生成它。"
  install -d -m 700 "$ENV_DIR"
  (
    umask 077
    {
      echo "# renrengame 线上服务的配置。改完之后执行 systemctl restart $SERVICE 生效。"
      grep -E '^(DATABASE_URL|REDIS_URL|MAP_SEED|MAX_PLAYERS)=' "$source_env"
      echo "PORT=$DEFAULT_PORT"
      echo "# 只监听本机，外面的访问都经过前面的代理（HTTPS）。"
      echo "HOST=$DEFAULT_HOST"
    } > "$ENV_FILE"
  )
  grep -q '^DATABASE_URL=' "$ENV_FILE" && grep -q '^REDIS_URL=' "$ENV_FILE" \
    || { rm -f "$ENV_FILE"; die "$source_env 里缺少 DATABASE_URL 或 REDIS_URL。"; }
  say "创建了 $ENV_FILE（只有 root 能读）。"
fi

env_value() { grep -E "^$1=" "$ENV_FILE" | tail -n 1 | cut -d= -f2-; }
port="$(env_value PORT)"; port="${port:-8080}"
host="$(env_value HOST)"; host="${host:-127.0.0.1}"
case "$host" in *:*) health_url="http://[$host]:$port/stats" ;; *) health_url="http://$host:$port/stats" ;; esac

# 服务还没在跑、端口却被别的程序占着（比如开发服务器），启动一定会失败，提前说清楚。
if ! systemctl is-active --quiet "$SERVICE" && [ -n "$(ss -ltnH "sport = :$port")" ]; then
  die "端口 $port 已经被别的程序占用（开发服务器还开着？）。先把它停掉，或者改 $ENV_FILE 里的 PORT。"
fi

# ---- 准备新版本 ----

release="$APP_DIR/releases/$(date -u +%Y%m%d-%H%M%S)-$short"
say "部署 $short 到 $release"
install -d -m 755 "$APP_DIR" "$APP_DIR/releases" "$release"
# 新版本切换成功之前，脚本不管因为什么退出，都把没用上的目录删掉。
discard_release=1
trap '[ "$discard_release" = 1 ] && rm -rf "$release"' EXIT

git -C "$REPO_DIR" archive --format=tar "$commit" | tar -x -C "$release"
echo "$commit" > "$release/REVISION"

say "安装依赖、检查、构建…"
(
  cd "$release"
  # 检查和构建不需要数据库，也不该读到线上的配置。
  unset DATABASE_URL REDIS_URL
  quiet pnpm install --frozen-lockfile || die "安装依赖失败。"
  quiet pnpm typecheck || die "类型检查没有通过。"
  quiet pnpm test || die "单测没有通过。"
  quiet pnpm build || die "客户端构建失败。"
)
[ -f "$release/packages/client/dist/index.html" ] || die "构建没有产出 index.html。"

# ---- systemd 服务 ----

node_bin="$(readlink -f "$(command -v node)")"
unit_tmp="$(mktemp)"
cat > "$unit_tmp" <<EOF
[Unit]
Description=renrengame 游戏服务器（2.5D 网页 MMO）
After=network-online.target postgresql.service redis-server.service
# 数据库或 Redis 暂时连不上时一直重试，不要重试几次就放弃。
StartLimitIntervalSec=0

[Service]
Type=simple
# 用一个临时的、没有任何权限的系统用户运行，不用 root。
DynamicUser=yes
WorkingDirectory=$APP_DIR/current/packages/server
Environment=NODE_ENV=production
Environment=STATIC_DIR=$APP_DIR/current/packages/client/dist
EnvironmentFile=$ENV_FILE
ExecStart=$node_bin --import tsx src/index.ts
Restart=always
RestartSec=3
# 收到 SIGTERM 后服务器会先保存所有在线角色再退出。
TimeoutStopSec=15
NoNewPrivileges=yes
ProtectHome=yes
PrivateDevices=yes
ProtectKernelTunables=yes
ProtectControlGroups=yes
RestrictSUIDSGID=yes

[Install]
WantedBy=multi-user.target
EOF
if ! cmp -s "$unit_tmp" "$UNIT_FILE"; then
  install -m 644 "$unit_tmp" "$UNIT_FILE"
  systemctl daemon-reload
  say "更新了 $UNIT_FILE"
fi
rm -f "$unit_tmp"

# ---- 切换并重启 ----

previous="$(readlink -f "$APP_DIR/current" 2>/dev/null || true)"
switch_to() {
  ln -s "$1" "$APP_DIR/current.new"
  mv -T "$APP_DIR/current.new" "$APP_DIR/current"
}
healthy() {
  for _ in $(seq 1 30); do
    sleep 1
    systemctl is-active --quiet "$SERVICE" || continue
    curl -fsS -m 2 -o /dev/null "$health_url" && return 0
  done
  return 1
}

switch_to "$release"
systemctl enable --quiet "$SERVICE"
systemctl restart "$SERVICE"

if healthy; then
  discard_release=0
  say "服务正常：$(curl -fsS -m 2 "$health_url")"
else
  say "新版本没有正常启动，最近的日志："
  journalctl -u "$SERVICE" -n 30 --no-pager || true
  if [ -n "$previous" ] && [ -d "$previous" ]; then
    say "切回上一个版本 $previous"
    switch_to "$previous"
    systemctl restart "$SERVICE"
    healthy && say "上一个版本已经恢复运行。" || say "上一个版本也没有起来，请查看日志。"
  else
    systemctl stop "$SERVICE"
    rm -f "$APP_DIR/current"
  fi
  die "部署没有完成。"
fi

# 只保留最近的几个版本。
ls -1d "$APP_DIR"/releases/*/ | sort | head -n "-$KEEP_RELEASES" | while read -r old; do
  [ "$(readlink -f "$old")" = "$(readlink -f "$APP_DIR/current")" ] || rm -rf "$old"
done

say "完成。当前版本 $short，日志：journalctl -u $SERVICE -f"
