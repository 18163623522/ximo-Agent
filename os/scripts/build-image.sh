#!/usr/bin/env bash
# ximo-OS 镜像构建编排 — 在 WSL Debian / 任意 Debian 系 Linux 中运行
# 用法：bash os/scripts/build-image.sh
# 前置：Windows 侧已跑 npm run host:build（产出 dist-host/agent-hostd.cjs）
set -euo pipefail

REPO_ROOT="${XIMO_REPO:-$(cd "$(dirname "$0")/../.." && pwd)}"
STAGE="$REPO_ROOT/os/mkosi/artifacts"

echo "[1/4] 前置检查"
test -f "$REPO_ROOT/dist-host/agent-hostd.cjs" || {
  echo "  ✗ 缺少 dist-host/agent-hostd.cjs — 先在 Windows 侧执行 npm run host:build"; exit 1
}
command -v mkosi >/dev/null || {
  echo "  ✗ 未安装 mkosi — 执行: sudo apt-get update && sudo apt-get install -y mkosi"; exit 1
}
command -v qemu-img >/dev/null || echo "  ⚠ 未安装 qemu-utils（转 VHDX 需要）：sudo apt-get install -y qemu-utils"

echo "[2/4] 归集主机运行时产物 → 镜像覆盖树"
# service 文件兼容两种布局：完整仓库（src/host/deploy）或精简构建树（os/mkosi/provision）
SERVICE_SRC=""
for cand in "$REPO_ROOT/src/host/deploy/agent-hostd.service" "$REPO_ROOT/os/mkosi/provision/agent-hostd.service"; do
  if [ -f "$cand" ]; then SERVICE_SRC="$cand"; break; fi
done
[ -n "$SERVICE_SRC" ] || { echo "  ✗ 找不到 agent-hostd.service"; exit 1; }

OVERLAY="$REPO_ROOT/os/mkosi/artifacts/image-overlay"
rm -rf "$REPO_ROOT/os/mkosi/artifacts"
mkdir -p \
  "$OVERLAY/opt/ximo-host/dist-host" \
  "$OVERLAY/etc/systemd/system/multi-user.target.wants" \
  "$OVERLAY/usr/local/sbin"
cp -f "$REPO_ROOT/dist-host/agent-hostd.cjs" "$OVERLAY/opt/ximo-host/dist-host/"
cp -f "$SERVICE_SRC" "$OVERLAY/etc/systemd/system/agent-hostd.service"
cp -f "$REPO_ROOT/os/mkosi/provision/ximo-os-firstboot.service" "$OVERLAY/etc/systemd/system/"
cp -f "$REPO_ROOT/os/mkosi/provision/firstboot.sh" "$OVERLAY/usr/local/sbin/ximo-os-firstboot.sh"
chmod 755 "$OVERLAY/usr/local/sbin/ximo-os-firstboot.sh"
# 相对软链 = systemctl enable 的等价物（不依赖 mkosi 脚本时序）
ln -sfn ../agent-hostd.service "$OVERLAY/etc/systemd/system/multi-user.target.wants/agent-hostd.service"
ln -sfn ../ximo-os-firstboot.service "$OVERLAY/etc/systemd/system/multi-user.target.wants/ximo-os-firstboot.service"

echo "[3/4] mkosi 构建（首次会下载 Debian 基础包，约几分钟）"
cd "$REPO_ROOT/os/mkosi"
mkosi build

echo "[4/4] 完成"
ls -lh out/ || true
cat <<'NEXT'

下一步（三选一）：
  A. 直接引导验证:        sudo apt-get install -y qemu-system-x86 && mkosi qemu
                          （WSL2 支持嵌套虚拟化；启动后 journalctl -u agent-hostd 看令牌）
  B. 转 Hyper-V VHDX:     qemu-img convert -f raw -O vhdx out/ximo-os_0.1.raw ximo-os_0.1.vhdx
                          （Windows: New-VM -Generation 2 挂载启动，关闭安全启动）
  C. 交付给裸机/其他虚拟化：直接用 out/ 下的 raw 磁盘镜像

验收清单见 os/README.md
NEXT
