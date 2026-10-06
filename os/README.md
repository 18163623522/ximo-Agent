# ximo-OS 0.1 — 镜像工程（阶段 1）

> 目标：一条命令构建出可启动的「ximo-OS」磁盘镜像——Debian trixie 底座 +
> agent-hostd 开机自启（headless，无 GUI）。控制面只有 SSH(22) 与 cockpit-link(17890)。

## 无 VT-x 运行策略（本机实测后确定）

这台机器 BIOS 开不了 VT-x，虚拟化路线全部作废，但架构本就宿主无关（cockpit-link
协议 + 用户态 Node 运行时），三层策略落地：

| 层 | 载体 | 状态 | 用途 |
|---|---|---|---|
| 日常运行 | **WSL1 Debian + agent-hostd**（免提权用户态部署） | ✅ 已验证跑通 | 现在就能用：驾驶舱/CLI 连 `127.0.0.1:17890` 派任务 |
| 镜像验证 | **QEMU TCG 纯软件模拟**（`os/scripts/run-image-tcg.ps1`） | 脚本就绪 | 启动慢（2-5 分钟）但不需要 VT-x，用于镜像验收/演示 |
| 正式生产 | CI 构建镜像 → **云主机 / 裸机**（均不需要本地 VT-x） | CI 就绪 | 阶段 2/3 的真实 OS 形态 |

### WSL1 快速开始（已在本机部署并验证）

```bash
npm run host:build                              # Windows 侧
wsl -d Debian -- bash -c "XIMO_REPO=/mnt/e/ximo2/ximo-Agent \
  bash /mnt/e/ximo2/ximo-Agent/src/host/deploy/install.sh"   # 自动装官方 node + 部署
wsl -d Debian -- /root/ximo-host/ximo-host run  # 前台常驻（会话保活）
# 令牌: wsl -d Debian -- cat /root/ximo-host/config/token
```

- WSL1 无 systemd：用 `ximo-host start/stop/status/log`（nohup 模式）或上面的
  `run` 前台模式 + Windows 任务计划保活（登录时执行上面的 run 命令即可）
- WSL1 已知坑（install.sh 已自动处理）：Debian 仓库的 nodejs 包在 WSL1 exec 层
  报 ENOEXEC，脚本会自动下载 nodejs.org 官方二进制兜底
- apiKey：编辑 `/root/ximo-host/config/config.json` 后重启（`stop && start`）

## 目录

```
os/
├── mkosi/
│   ├── mkosi.conf            # 镜像定义（Debian trixie / disk 格式 / 主机产物映射）
│   ├── provision/postinstall.sh           # 镜像内：建用户/启用服务/锁 root
│   ├── provision/firstboot.sh             # 首启：目录/配置占位/令牌提示（跑一次）
│   └── provision/ximo-os-firstboot.service
├── scripts/build-image.sh   # 构建编排（归集产物 → mkosi build）
└── kernel/README.md          # 阶段 3 内核定制预案（阶段 1 不动内核）
```

## 构建步骤

> ⚠️ **本机限制（2026-09 实测）**：这台 Windows 的 Debian 是 **WSL1**（无真内核，
> mkosi 无法运行），且 BIOS 未开 VT-x（HypervisorPresent=False，WSL2 不可用）、
> C 盘 100% 满。因此镜像构建走 **CI 路线**；本地路线在「C 盘清理 + BIOS 开
> VT-x + `wsl --set-version Debian 2`」三件事完成后解锁。

**路线 A（推荐）：GitHub Actions 自动构建**
- 推送到 master 或手动触发 `ximo-OS 镜像` workflow（`.github/workflows/ximo-os-image.yml`）
- 自动完成：host 产物构建 → mkosi 打镜像 → QEMU 引导冒烟 → 上传 `*.raw` 工件（保留 7 天）

**路线 B（任意有真内核的 Debian 系 Linux：另一台机器 / 云主机 / 解锁后的 WSL2）**：

第 1 步（Windows 侧）：产出主机运行时
```
npm run host:build        # → dist-host/agent-hostd.cjs
```

第 2 步（Linux 侧）：
```bash
sudo apt-get install -y mkosi qemu-utils
bash os/scripts/build-image.sh
```
首次构建会下载 Debian 基础包（几分钟）；产物在 `os/mkosi/out/ximo-os_0.1.raw`。

**第 3 步（可选）：转 Hyper-V 可用格式**
```bash
qemu-img convert -f raw -O vhdx os/mkosi/out/ximo-os_0.1.raw ximo-os_0.1.vhdx
```

## 启动验证（三选一）

| 方式 | 命令 | 说明 |
|---|---|---|
| QEMU（最快） | `cd os/mkosi && mkosi qemu` | WSL2 支持嵌套虚拟化；退出按 Ctrl+a x |
| Hyper-V | New-VM -Generation 2，挂 VHDX，**关闭安全启动** | Windows 原生管理 |
| 裸机 | dd/raw 写U盘，UEFI 启动 | 阶段 3 再正式支持 |

## 验收清单（阶段 1 达成标准）

- [ ] 全新 VM 从镜像启动到 agent-hostd 就绪 ≤ 2 分钟
- [ ] `journalctl -u agent-hostd` 可见首次生成的访问令牌
- [ ] Windows 宿主机 `curl http://<VM IP>:17890/api/health -H "Authorization: Bearer <令牌>"` 返回 200
- [ ] WS 派一个任务（如「在工作区创建 hello.txt」）→ done(completed)，产物在工作区目录
- [ ] 审批路径：派一个含 terminal_exec 的任务 → 驾驶舱侧收到 approval.request

## 首启之后你需要做的

1. SSH 进系统（root 密码已锁死；用 Hyper-V/QEMU 控制台或注入密钥），编辑
   `/opt/ximo-host/config/config.json` 填入 `apiKey`，然后
   `systemctl restart agent-hostd`
2. 令牌：`cat /opt/ximo-host/config/token`（或 journalctl 回显）

## 已知边界

- 无 GUI（阶段 2 加自研桌面壳）；无快照回滚（阶段 3 btrfs）
- SSH 登录目前建议走 VM 控制台配密钥；镜像默认未注入任何密钥
- mkosi 需要 ≥ 24（配置已按 24.3 / 25.3 双版本验证语法）；构建需访问 deb.debian.org
- **本机 Debian 是 WSL1 且 BIOS 未开 VT-x**：本地构建镜像不可行，走 CI 路线；
  解锁三件事：清理 C 盘 → BIOS 开 VT-x → `wsl --set-version Debian 2`
