#!/usr/bin/env bash
# 用户态常驻管理 — WSL1 / 无 systemd 环境（免提权）
# 用法: ximo-host {start|stop|status}
set -euo pipefail

DIR="${XIMO_HOST_HOME:-$HOME/ximo-host}"
CJS="$DIR/dist-host/agent-hostd.cjs"
PID="$DIR/agent-hostd.pid"
LOG="$DIR/agent-hostd.log"
NODE="${NODE:-node}"
# install.sh 持久化的官方 node 路径优先 — PATH 上的 node 在 WSL1 可能是坏包
[ -f "$DIR/node.env" ] && . "$DIR/node.env"

is_running() {
  [ -f "$PID" ] && kill -0 "$(cat "$PID")" 2>/dev/null
}

case "${1:-status}" in
  start)
    [ -f "$CJS" ] || { echo "缺少 $CJS — 先跑 npm run host:build 并重跑 install.sh"; exit 1; }
    command -v "$NODE" >/dev/null || { echo "需要 node — Debian: sudo apt-get install -y nodejs"; exit 1; }
    if is_running; then echo "已在运行 (PID $(cat "$PID"))"; exit 0; fi
    (cd "$DIR" \
      && XIMO_HOST_DIR="$DIR/config" XIMO_HOST_DATA="$DIR/data" \
      nohup "$NODE" "$CJS" >> "$LOG" 2>&1 & echo $! > "$PID")
    sleep 1
    if is_running; then
      echo "✅ agent-hostd 已启动 (PID $(cat "$PID"))"
      echo "   日志: $LOG · 令牌: $DIR/config/token · 控制面: 127.0.0.1:17890"
    else
      echo "✗ 启动失败 — 见 $LOG"; exit 1
    fi
    ;;
  stop)
    if is_running; then kill "$(cat "$PID")"; rm -f "$PID"; echo "已停止"; else echo "未在运行"; rm -f "$PID"; fi
    ;;
  status)
    if is_running; then echo "运行中 (PID $(cat "$PID"))"; else echo "未运行"; fi
    ;;
  log)
    tail -n 30 "$LOG" 2>/dev/null || echo "无日志"
    ;;
  run)
    # 前台运行 — 供 Windows 任务计划/会话保活包装使用：
    #   wsl -d Debian -- ~/ximo-host/ximo-host run
    # 该 wsl.exe 进程存活期间 agent-hostd 存活（WSL1 会话模型决定的）
    XIMO_HOST_DIR="$DIR/config" XIMO_HOST_DATA="$DIR/data" exec "$NODE" "$CJS"
    ;;
  *)
    echo "用法: $0 {start|stop|status|log}"; exit 1
    ;;
esac
