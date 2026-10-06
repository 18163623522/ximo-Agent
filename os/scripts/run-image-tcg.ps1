# ximo-OS 镜像本地引导 — QEMU TCG 纯软件模拟（无需 VT-x / 无需 Hyper-V）
#
# 前置：
#   1. Windows 版 QEMU: https://qemu.weilnetz.de/w64/ 安装后加入 PATH
#   2. 镜像: os/mkosi/out/ximo-os_0.1.raw（CI 工件或 build-image.sh 产物）
#
# 用法:  powershell -File os\scripts\run-image-tcg.ps1
# 可选参数: -Image <路径> -Cores 4 -Memory 2G -SshPort 12222 -ApiPort 17890
#
# 启动后（TCG 软件模拟，引导约 2-5 分钟，属正常）：
#   cockpit-link: http://127.0.0.1:17890/api/health  (Bearer 令牌见 VM 内 /opt/ximo-host/config/token)
#   SSH 转发:     ssh -p 12222 ximo-os 本地回环（root 已锁死，走 VM 控制台配密钥）
param(
  [string]$Image = (Join-Path $PSScriptRoot "..\mkosi\out\ximo-os_0.1.raw"),
  [int]$Cores = 4,
  [string]$Memory = "2G",
  [int]$SshPort = 12222,
  [int]$ApiPort = 17890
)

$ErrorActionPreference = "Stop"
$Image = (Resolve-Path $Image -ErrorAction SilentlyContinue)?.Path ?? $Image
if (-not (Test-Path $Image)) {
  Write-Host "✗ 找不到镜像: $Image"
  Write-Host "  先走 CI 构建（.github/workflows/ximo-os-image.yml）或 build-image.sh"
  exit 1
}
if (-not (Get-Command "qemu-system-x86_64.exe" -ErrorAction SilentlyContinue)) {
  Write-Host "✗ 未找到 qemu-system-x86_64.exe"
  Write-Host "  安装: https://qemu.weilnetz.de/w64/ （安装时勾选 Add to PATH）"
  exit 1
}

Write-Host "Booting ximo-OS (TCG 软件模拟 — 无 VT-x 也可运行)..."
Write-Host "  内存: $Memory · CPU: $Cores 核"
Write-Host "  cockpit-link 转发: http://127.0.0.1:$ApiPort → guest:17890"
Write-Host "  SSH 转发:          127.0.0.1:$SshPort → guest:22"
Write-Host "  退出 QEMU: Ctrl+a 然后 x"
Write-Host ""

& qemu-system-x86_64.exe `
  -m $Memory -smp $Cores -accel tcg,thread=multi `
  -drive "file=$Image,format=raw,if=virtio" `
  -nic "user,model=virtio-net-pci,hostfwd=tcp::${SshPort}-:22,hostfwd=tcp::${ApiPort}-:17890" `
  -nographic
