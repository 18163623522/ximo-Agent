# HANDOFF.md — 交接文档：ximo-OS 二次开发（供接手的编程 Agent）

> 写给下一个接手的编程 Agent。读完这份文档，你应当知道：项目在哪、已完成什么、
> 还剩什么、每件事怎么做、有哪些坑。**本文档由 2026-10-06 会话更新，
> 所述"实测"均为真实执行过的验证。**

---

## 0. 30 秒速览

- **项目**：ximo-Agent（Electron 桌面 AI Agent，本仓库）+ **ximo-OS**（目标：完全
  适配自家 Agent 的 Linux OS；已拍板"直接自研"路线，四阶段推进）
- **当前位置**：阶段 0/0.5 ✅、阶段 1 工程件 ✅（CI 镜像构建调试到第 16 轮，见 §5）、
  **P0-2 驾驶舱对接 ✅**、**P1-2 视觉回路 ✅**、**P1-1 阶段 2 内核+桌面渲染端 ✅**
  （desktop-bus + ximo-OS 桌面 UI）、阶段 2 剩余（文档/浏览器 app API）未开始
- **主机已真实可用**：agent-hostd v1 常驻运行 + 密钥已配 + E2E 冒烟通过
  （WS 派任务 → LLM → 1.1s 返回「链路正常」）
- **关键约束**：本机 BIOS 无 VT-x → WSL2/Hyper-V/KVM 永久不可用；WSL1 只有 Debian trixie
- **网络坑**：本机 git 代理 `127.0.0.1:12450` 已失效；直连 GitHub 不稳定（时通时断）。
  推送用 `git -c http.proxy= -c https.proxy= -c http.version=HTTP/1.1 push origin master`
  并多重试；实在推不上用 `gh api` Contents API 写文件（gh 一直稳定）

## 1. 必读文档（按此顺序）

1. `AGENTS.md` — 编码规范与硬规则（行数上限/文件拆分），**必须遵守**
2. `docs/ENGINEERING.md` + `docs/TESTING.md` — 模块地图与测试体系
3. `docs/ximo-os/PROTOCOL.md` — **cockpit-link v1 协议契约**（含 desktop-bus 动作表）
4. `os/README.md` — 镜像工程使用说明
5. 本文件

## 2. 环境事实（实测结论，不要重复踩坑）

| 项 | 事实 |
|---|---|
| 宿主 | Windows 10 + Git Bash；Node v24；仓库 `"type": "module"` |
| WSL | Debian 13.5 (trixie)，**WSL1**（无真内核，mkosi/容器本地跑不了） |
| VT-x | BIOS 开不了 → WSL2/Hyper-V/KVM 永久不可用 |
| 主机部署 | agent-hostd v1 部署于 WSL1 `/root/ximo-host/`（产物+官方 node v20.19.2+config） |
| 运行状态 | **常驻运行**：Windows 任务计划 `ximo-hostd`（登录时前台 `run` 保活）；apiKey 已配置；**E2E 冒烟通过**（派任务→`链路正常`，1.1s） |
| 网络 | git 代理 12450 已死；GitHub 直连不稳；gh CLI（api.github.com）一直稳定 |

**WSL1/环境坑（均已踩过，勿重复）**：
1. Git Bash 调 wsl.exe 时 `/root/...` 会被 MSYS 转换 → 加 `MSYS_NO_PATHCONV=1`；
   但 node 的 `execSync('wsl ...')` 走 cmd.exe，**不要**加该前缀
2. node 里 `fs.writeFileSync('/tmp/...')` 写到 `C:\tmp`，与 Git Bash 的 /tmp 不同 →
   跨 shell 传文件一律用仓库相对路径（WSL 侧对应 `/mnt/e/ximo2/ximo-Agent/...`）
3. `cat x | wsl ... cat > file` **stdin 管道不可靠**（实测收到 0 字节）→ 传文件用 /mnt 拷贝
4. `pkill -f 'ximo-hos[t].cjs'` **杀不到真实进程**（路径是 `dist-host/agent-hostd.cjs`）→
   用 `pkill -f 'agent-hostd[.]cjs'`（方括号防自匹配）
5. `ximo-host stop`（PID 文件方式）正常可用；`start` 的 nohup 随 wsl 会话死 →
   常驻靠任务计划 `run` 模式；改配置后重启 = `schtasks /end` + `/run`（需 MSYS_NO_PATHCONV=1，
   否则 Git Bash 把 /end /run 当路径）
6. shell 管道里判断成败别用 `if git push | tail -1`（tail 恒 0）→ 用 `| grep -q "成功标记"`

**日常操作命令**：
```bash
# 状态 / 令牌 / 健康
MSYS_NO_PATHCONV=1 wsl -d Debian -- /root/ximo-host/ximo-host status
MSYS_NO_PATHCONV=1 wsl -d Debian -- cat /root/ximo-host/config/token
curl -s -H "Authorization: Bearer <令牌>" http://127.0.0.1:17890/api/health   # → {"ok":true,"version":1,...}
# 改配置后重启（config.json 含 apiKey，勿回显）
MSYS_NO_PATHCONV=1 schtasks /end /tn ximo-hostd; MSYS_NO_PATHCONV=1 schtasks /run /tn ximo-hostd
# 端到端冒烟（node + ws 包，见 git log 里的 .ximo-smoke.mjs 模式）
# 应用数据：C:\Users\Administrator\AppData\Roaming\ximo-agent\ximo-agent\（settings.json+secure.enc）
# 旧版明文密钥：C:\Users\Administrator\AppData\Roaming\ximo-agent\settings.json（已验证有效，已装入主机）
```

## 3. 架构现状（全部已实现并测试）

```
驾驶舱（Electron App）
  ├─ 本地 Agent（chat 管线，操作真实 Windows）
  └─ 远程主机客户端 = src/main/host/HostClient（WS 重连/心跳/任务表/desktopRequest）
        ↕ cockpit-link v1（HOST_VERSION=1；类型单一来源 src/shared/types/cockpit.ts）
agent-hostd v1（src/host/，esbuild 单文件 dist-host/agent-hostd.cjs）
  ├─ 权限引擎 = 主应用 Permission.ts（desktop 工具全量 allow，terminal_exec ask）
  ├─ Agent 循环 = 主应用 deepseek/agent-loop（electron-shim 供纯 Node 运行）
  ├─ 工具域 6 组 + desktop 工具（纯 API 零截图路径）
  ├─ desktop-bus = src/host/desktop/（backend: xdotool/wmctrl；bus: 路由+2s事件轮询）
  └─ screen = src/host/desktop/screen.ts（ffmpeg MJPEG 自愈 + import 快照）
```

**驾驶舱 UI 入口**：AgentSystemPanel（Agent 系统）→ 第 4 tab「远程主机」= RemoteHostTab
（配置/连接/派任务/转录/审批）→「打开桌面」= XimoOsDesktopPanel（画面流 + 窗口树 +
应用启动 + 键鼠注入 + 画布点击坐标映射）。画面经 `ximo-host-cam://` 自定义协议
（src/main/host/cam-protocol.ts）代理主机 `/api/screen/stream`。

## 4. 本会话（2026-10-06）完成清单

1. **cockpit 全链路对接（P0-2）**：协议类型下沉 shared、HostClient、host:* IPC 8+3 通道、
   preload、RemoteHostTab、HostClient 集成测试 12 例（真 server 驱动）
2. **视觉回路（P1-2）**：截图留存 Windows 临时目录（/mnt/c 挂载，24h 清理）→
   `vision_analyze(file_path=…)` 闭环；未走 image_url 直传（理由见 §7 决策 10）
3. **desktop-bus 内核（P1-1 上半）**：协议 v1 `desktop.request/reply/event`、
   window/app/key/type/mouse/screen.size 全动作、事件轮询、主机 Agent `desktop` 工具
4. **ximo-OS 桌面 UI（P1-1 下半·渲染端）**：screen.ts 采集、/api/screen/stream+snapshot
   （Bearer）、ximo-host-cam:// 协议、XimoOsDesktopPanel
5. **主机真实部署**：v1 部署 + 任务计划保活 + 密钥配置 + E2E 冒烟通过
6. **测试基线**：46 文件 / 856+ 用例全绿（新增 host-client 12 例、desktop-bus 14 例、
   视觉回路 4 例）；typecheck 0 错误；host:build 通过

## 5. 唯一进行中：CI 镜像构建（P0-1，第 16 轮）

**已连续排除 8 个问题**（每个都实测过，别再踩）：
① AppArmor 禁非特权 userns → `sudo -E bash build-image.sh`（root 构建）
② 缺 ukify → noble 包名 `systemd-ukify`
③ 缺 bootctl → noble 包名 `systemd-boot`
④ PyPI 无 mkosi → 从 Debian 池取 deb
⑤ noble apt 版 mkosi 24.3 工具树包名不兼容 t64（libtss2-mu0 已改名）→ 用 trixie 的
   `mkosi_25.3-7_all.deb`（注意 -7 后缀，-1 是 404）
⑥ `ToolsTree=yes` 在 25.3 已废弃（"yes does not exist"）
⑦ GITHUB_PATH/GITHUB_ENV **同步骤不生效**；sudo 会剥离 PYTHONPATH →
   解包 + `/usr/local/bin/mkosi` 包装脚本（自带 PYTHONPATH，root 可见）——已验证可行
⑧ mkosi deb 依赖无法在 noble 解析 → **不要** `apt-get install /tmp/mkosi.deb`

**第 16 轮（进行中）**：`ToolsTree=no` + 宿主直装 `systemd-ukify`/`systemd-boot`
（commit b15a40fe，run 37420133948）。若失败看 `gh run view <id> --log-failed`，
下一个候选：mkosi 25.3 root 构建对 trixie 工具的其他要求（如 systemd-repart 版本），
备选方案 = 装 `systemd-container` 或回退 ToolsTree 指向显式路径。

**成功后**：`gh run download <run-id> -n ximo-os-0.1-raw -D deliverables/ximo-os-image`，
然后按 `os/README.md` 验收清单跑 `os/scripts/run-image-tcg.ps1` 引导。

## 6. 未完成工作（优先级）

- **P0-1**：镜像构建收尾（§5）→ 5 项验收清单（os/README.md）
- **P1-1 阶段 2 剩余**：文档/浏览器两个 app 的语义化 JSON API；画面采集分辨率固定
  1280x800（set_resolution 后需同步，ScreenCapture 构造参数）
- **P1-3 人工接管**（先问用户）：cockpit 键鼠 → `input.*` 消息 → 镜像内注入
- **P2-1 阶段 3**：btrfs 快照回滚、eBPF 审计、按任务用户沙箱、并发隔离（当前 runner
  chdir/写白名单是进程级全局，只能串行）
- **聊天区路由**（产品决策）：让聊天任务可选派发到 ximo-OS——注意涉及真实文件的任务
  必须留本地（主机沙箱碰不到 Windows 文件系统）
- **技术债**：`tests/main/tools/office-docs-e2e.test.ts` 依赖真实 officecli 偶发失败；
  `scripts/test-vd*.ps1` 为前人遗留去留自定

## 7. 关键决策记录（勿轻易推翻）

1. cockpit-link 宿主无关（同一协议跑 WSL1/QEMU-TCG/云/裸机）
2. headless-first：桌面本体是 desktop-bus API，驾驶舱桌面面板与主机 Agent 是**同等客户端**
3. 门面模式拆文件；行数上限硬执行
4. fail-closed：审批超时=拒绝
5. 权限同源：host 直接 import 主应用 Permission.ts（desktop 工具全量 allow 的隔离桌面理由见注释）
6. esbuild 单文件打包 host；electron-shim 复用主应用代码
7. 任务串行（并发隔离属阶段 3）
8. **协议版本纪律**：新增 `t` 类型 → HOST_VERSION+1（已 0→1）；字段只增不改；
   消息类型单一来源 `src/shared/types/cockpit.ts`，host/protocol.ts 仅留运行时校验
9. **视觉回路走留存路径而非 image_url 直传**：ContextManager/重建/tokenizer 均按
   纯字符串处理消息，且 DeepSeek tool 角色多模态行为无法本地验证（400 风险）；
   若将来要做，先挂 ProviderCapabilities 门控并在真实端点验证
10. **git 推送降级链**：直连重试(HTTP/1.1) → gh api Contents API 写文件（注意
    远端领先时先 `git pull --rebase`，否则 push 被拒且 workflow_dispatch 会跑旧代码——
    dispatch 前必须核对 run 的 headSha == 本地 HEAD）

## 8. 验证命令（任何改动后必跑）

```bash
npm run typecheck        # 0 错误
npx vitest run           # 46 文件 / 856+ 用例全绿
npm run host:build       # 改 src/host 或依赖后必跑
# 主机重新部署（改 host 运行时后）：
npm run host:build
MSYS_NO_PATHCONV=1 wsl -d Debian -- bash -c "XIMO_REPO=/mnt/e/ximo2/ximo-Agent bash /mnt/e/ximo2/ximo-Agent/src/host/deploy/install.sh"
MSYS_NO_PATHCONV=1 schtasks /end /tn ximo-hostd; MSYS_NO_PATHCONV=1 schtasks /run /tn ximo-hostd
# 冒烟：health 应返回 version:1；WS 派任务应 completed
```
