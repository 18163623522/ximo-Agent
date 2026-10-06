#!/bin/bash
# mkosi PostInstallation 脚本 — 在镜像 chroot 内以 root 执行
# 职责：建系统用户、锁 root。（服务文件与 wants 软链由 ExtraTrees 覆盖树落位，
# 无需 systemctl enable —— 时序免疫）
#
# 注意（均来自 CI 实测报错）：
#  - 镜像里可能没有 /usr/sbin/nologin（`login` 包未显式安装）→ 探测可用路径
#  - chroot 期间 / 可能只读 → 写 /etc/hostname 前先确保可写
set -euo pipefail

# 系统用户 — agent-hostd 以其身份运行（非 root，阶段 3 升级为按任务隔离）
# nologin 路径跨发行版不同（Debian 新版把 /sbin 并入 /usr/sbin），探测后回退 /bin/false
NOLOGIN=""
for cand in /usr/sbin/nologin /sbin/nologin /usr/bin/nologin /bin/false; do
  [ -x "$cand" ] && NOLOGIN="$cand" && break
done
[ -n "$NOLOGIN" ] || NOLOGIN=/bin/false

if ! id -u ximo-host >/dev/null 2>&1; then
  useradd --system --home /opt/ximo-host --shell "$NOLOGIN" ximo-host
fi

# 主机名 — chroot 内 / 可能是只读挂载，先尝试重挂为可写（失败则跳过，不阻断构建）
if ! echo ximo-os > /etc/hostname 2>/dev/null; then
  if mount -o remount,rw / 2>/dev/null; then
    echo ximo-os > /etc/hostname || echo "[ximo-os] 警告：hostname 写入失败（不影响主机运行）"
  else
    # 部分构建环境 hostname 由 mkosi 的 Hostname= 或 systemd 管理，跳过即可
    echo "[ximo-os] 跳过 /etc/hostname（文件系统只读，由 mkosi/systemd 接管）"
  fi
fi

# root 密码锁死 — 入口只有 SSH 密钥（可选注入）与 Hyper-V/QEMU 控制台
passwd -l root >/dev/null 2>&1 || true

echo "[ximo-os] postinstall 完成：ximo-host 用户就绪（shell=$NOLOGIN），服务经覆盖树软链启用"
