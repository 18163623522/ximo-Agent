#!/bin/bash
# mkosi PostInstallation 脚本 — 在镜像 chroot 内以 root 执行
# 职责：建系统用户、锁 root。（服务文件与 wants 软链由 ExtraTrees 覆盖树落位，
# 无需 systemctl enable —— 时序免疫）
set -euo pipefail

# 系统用户 — agent-hostd 以其身份运行（非 root，阶段 3 升级为按任务隔离）
id -u ximo-host >/dev/null 2>&1 || useradd --system --home /opt/ximo-host --shell /usr/sbin/nologin ximo-host

# 主机名（跨 mkosi 24/25 版本兼容的写法：不用 mkosi 的 Hostname 设置）
echo ximo-os > /etc/hostname

# root 密码锁死 — 入口只有 SSH 密钥（可选注入）与 Hyper-V/QEMU 控制台
passwd -l root >/dev/null 2>&1 || true

echo "[ximo-os] postinstall 完成：ximo-host 用户就绪，服务经覆盖树软链启用"
