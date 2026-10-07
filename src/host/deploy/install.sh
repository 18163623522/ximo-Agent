#!/usr/bin/env bash
# agent-hostd 部署 — 自动选择模式：
#   [模式 A] systemd 可用（WSL2 / VM / 裸机）→ 系统服务 /opt/ximo-host（需 root）
#   [模式 B] WSL1 / 无 systemd → 用户态常驻 ~/ximo-host（免提权，VT-x 无关）
# 用法：XIMO_REPO 默认取脚本所在仓库根；也可显式指定
set -euo pipefail

REPO_ROOT="${XIMO_REPO:-$(cd "$(dirname "$0")/../.." && pwd)}"
test -f "$REPO_ROOT/dist-host/agent-hostd.cjs" || {
  echo "✗ 缺少 $REPO_ROOT/dist-host/agent-hostd.cjs — 先执行 npm run host:build"; exit 1
}

has_systemd() {
  command -v systemctl >/dev/null 2>&1 && [ "$(ps -p 1 -o comm= 2>/dev/null)" = "systemd" ]
}

if has_systemd && [ "$(id -u)" = "0" ]; then
  # ---------- 模式 A：systemd 系统服务 ----------
  echo "[模式 A] systemd 系统服务部署 → /opt/ximo-host"
  DEST=/opt/ximo-host
  mkdir -p "$DEST/config" "$DEST/data" "$DEST/dist-host"
  cp -f "$REPO_ROOT"/dist-host/*.cjs "$DEST/dist-host/"
  install -m 644 "$(dirname "$0")/agent-hostd.service" /etc/systemd/system/agent-hostd.service
  id -u ximo-host >/dev/null 2>&1 || useradd --system --home "$DEST" --shell /usr/sbin/nologin ximo-host
  chown -R ximo-host:ximo-host "$DEST"
  if [ ! -f "$DEST/config/config.json" ]; then
    cat > "$DEST/config/config.json" <<'EOF'
{
  "listen": "0.0.0.0:17890",
  "baseUrl": "https://api.deepseek.com/v1",
  "apiKey": "",
  "model": "deepseek-chat",
  "mode": "coding"
}
EOF
    chmod 600 "$DEST/config/config.json"
    echo "  → 请编辑 $DEST/config/config.json 填入 apiKey"
  fi
  systemctl daemon-reload
  systemctl enable --now agent-hostd.service
  sleep 1
  systemctl --no-pager status agent-hostd | head -6 || true
  echo "令牌: journalctl -u agent-hostd | grep 'token =' 或 cat $DEST/config/token"
else
  # ---------- 模式 B：用户态常驻（WSL1 / 无 systemd / 免提权） ----------
  echo "[模式 B] 用户态部署（WSL1 / 无 systemd）→ ~/ximo-host"
  DEST="${XIMO_HOST_HOME:-$HOME/ximo-host}"
  mkdir -p "$DEST/config" "$DEST/data" "$DEST/dist-host"

  # node 就绪 — WSL1 已知坑：Debian 仓库的 nodejs 包（libnode 巨型 ELF）在 WSL1
  # exec 层报 ENOEXEC，官方 nodejs.org 二进制可正常运行 → 自动下载兜底
  NODE_VER="v20.19.2"
  NODE_BIN=""
  if command -v node >/dev/null 2>&1 && node -e '' 2>/dev/null; then
    NODE_BIN="$(command -v node)"
  elif [ -x "$DEST/node/bin/node" ] && "$DEST/node/bin/node" -e '' 2>/dev/null; then
    NODE_BIN="$DEST/node/bin/node"
  else
    echo "  → 系统不可用，下载官方 Node $NODE_VER（nodejs.org，约 25MB）"
    mkdir -p "$DEST/node"
    local_tgz="$DEST/node.tar.xz"
    if [ ! -f "$local_tgz" ]; then
      ok=0
      for fetcher in "curl -fsSL -o" "wget -qO"; do
        # shellcheck disable=SC2086
        if $fetcher "$local_tgz" "https://nodejs.org/dist/$NODE_VER/node-$NODE_VER-linux-x64.tar.xz" 2>/dev/null; then
          ok=1; break
        fi
      done
      if [ "$ok" != "1" ] && [ -x /mnt/c/Windows/System32/curl.exe ] && command -v wslpath >/dev/null; then
        # WSL1 兜底：借 Windows curl，输出路径换算为 Windows 形式
        win_tgz="$(wslpath -w "$local_tgz" 2>/dev/null || true)"
        if [ -n "$win_tgz" ]; then
          /mnt/c/Windows/System32/curl.exe -fsSL -o "$win_tgz" "https://nodejs.org/dist/$NODE_VER/node-$NODE_VER-linux-x64.tar.xz" && ok=1
        fi
      fi
      [ "$ok" = "1" ] || { echo "  ✗ Node 下载失败 — 手动放置 $local_tgz（node-$NODE_VER-linux-x64.tar.xz）后重试"; exit 1; }
    fi
    tar xf "$local_tgz" -C "$DEST/node" --strip-components=1 && rm -f "$local_tgz"
    NODE_BIN="$DEST/node/bin/node"
  fi
  echo "  → node: $NODE_BIN ($("$NODE_BIN" --version))"
  # 持久化 node 路径 — PATH 上的 node 可能是 WSL1 不可执行的坏包（实测踩坑）
  echo "NODE=$NODE_BIN" > "$DEST/node.env"

  cp -f "$REPO_ROOT"/dist-host/*.cjs "$DEST/dist-host/"
  install -m 755 "$(dirname "$0")/ximo-host-wsl1.sh" "$DEST/ximo-host"
  if [ ! -f "$DEST/config/config.json" ]; then
    cat > "$DEST/config/config.json" <<'EOF'
{
  "listen": "127.0.0.1:17890",
  "baseUrl": "https://api.deepseek.com/v1",
  "apiKey": "",
  "model": "deepseek-chat",
  "mode": "coding"
}
EOF
    chmod 600 "$DEST/config/config.json"
    echo "  → 请编辑 $DEST/config/config.json 填入 apiKey"
  fi
  cat <<NEXT

部署完成。控制命令：
  ~/ximo-host/ximo-host start    # 启动（后台常驻，NODE=$NODE_BIN）
  ~/ximo-host/ximo-host status   # 状态
  ~/ximo-host/ximo-host log      # 最近日志
  ~/ximo-host/ximo-host stop     # 停止
令牌: cat ~/ximo-host/config/token （首次 start 后生成）
开机自启（可选）：Windows 任务计划程序在登录时执行
  wsl -d Debian -- ~/ximo-host/ximo-host start
NEXT
fi
