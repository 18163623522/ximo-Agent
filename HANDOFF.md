# HANDOFF.md — 交接文档：ximo-OS 二次开发（供接手的编程 Agent）

> 写给下一个接手的编程 Agent。读完这份文档，你应当知道：项目在哪、已完成什么、
> 还剩什么、每件事怎么做、有哪些坑。**本文档由上一个 Agent 于 2026-09-30 写下，
> 所述"实测"均为真实执行过的验证。**

---

## 0. 30 秒速览

- **项目**：ximo-Agent（Electron 桌面 AI Agent，本仓库）+ **ximo-OS**（目标：一个完全
  适配自家 Agent 的 Linux OS 桌面系统，用户已拍板"直接自研"路线）
- **路线**：四阶段推进。阶段 0（运行时搬家验证）✅、阶段 0.5（真 agent-loop 移植）✅、
  阶段 1（镜像工程）工程件 ✅ / **验收未跑（本机硬件限制，走 CI）**、阶段 2 未开始、
  阶段 3 未开始
- **关键约束**：这台机器 **BIOS 开不了 VT-x**（实测 HypervisorPresent=False）→
  WSL2/Hyper-V/KVM 全部不可用。已确定"无 VT-x 三层策略"（见 §3），方案已实测跑通
- **工作树状态**：本会话全部改动**未提交**（约 24 个 M/?? 文件，清单见 §7）。
  接手第一步建议：通读本文档 → `git add -A && git commit`（一次性落盘，防丢失）

## 1. 必读文档（按此顺序）

1. `AGENTS.md` — 编码规范与硬规则（行数上限/文件拆分/禁止事项），**必须遵守**
2. `docs/ENGINEERING.md` — 模块地图、门面模式、加新功能的常规路径
3. `docs/TESTING.md` — 六类测试体系与运行方式
4. `docs/ximo-os/PROTOCOL.md` — **cockpit-link v0 协议契约**（驾驶舱↔主机的唯一契约）
5. `os/README.md` — 镜像工程使用说明（构建/引导/验收清单/无 VT-x 策略）
6. 本文件

## 2. 环境事实（实测结论，不要重复踩坑）

| 项 | 事实 |
|---|---|
| 宿主 | Windows 10 + Git Bash；Node v24；仓库 `package.json` 为 `"type": "module"` |
| WSL | 只有 **Debian 13.5 (trixie)，且是 WSL1**（无真 Linux 内核） |
| VT-x | **BIOS 开不了**（HypervisorPresent=False）→ WSL2/Hyper-V/KVM 永久不可用 |
| 磁盘 | C 盘已清理（约 27GB 可用）；E 盘约 50GB |
| 本机部署 | agent-hostd 已部署在 WSL1：`/root/ximo-host/`（单文件产物 + 官方 node v20.19.2 + config） |
| 运行状态 | **默认未运行**（WSL1 会话结束进程即被清，见下） |

**WSL1 三大坑（代码/脚本已绕过，但你写新命令时会撞上）**：
1. Git Bash 调 `wsl.exe` 时 `/root/...` 会被 MSYS 转换成 Windows 路径 →
   一律加前缀 `MSYS_NO_PATHCONV=1`
2. Debian 仓库的 nodejs 包在 WSL1 exec 层报 ENOEXEC → 必须用 nodejs.org 官方二进制
   （`install.sh` 模式 B 已自动下载到 `/root/ximo-host/node/`）
3. WSL1 无 systemd；且**启动它的 wsl 会话退出后进程组被清** →
   常驻 = 前台 `run` 模式 + Windows 侧会话保活（任务计划程序登录时执行
   `wsl -d Debian -- /root/ximo-host/ximo-host run`）
4. `pkill -f 'xxx.cjs'` 会匹配执行它的 bash 自身命令行把自己杀掉 →
   用 `pkill -f 'xxx[.]cjs'`（方括号正则防自匹配）

**日常操作命令**（本机已部署）：
```bash
# 启动（前台保活；建议包在任务计划里）
wsl -d Debian -- /root/ximo-host/ximo-host run
# 或后台（仅当前 wsl 会话存活期间有效）
MSYS_NO_PATHCONV=1 wsl -d Debian -- /root/ximo-host/ximo-host start
# 令牌 / 健康
MSYS_NO_PATHCONV=1 wsl -d Debian -- cat /root/ximo-host/config/token
curl -s -H "Authorization: Bearer <令牌>" http://127.0.0.1:17890/api/health
# ⚠️ config.json 里 apiKey 为空 → 派任务会 failed("未配置 API Key")，这是预期行为
```

## 3. 架构现状

```
驾驶舱（Windows Electron App；UI 对接 = P0-2 未完成）
    ↕ cockpit-link v0（WS 17890/ws + REST；契约 = docs/ximo-os/PROTOCOL.md）
agent-hostd（Linux 用户态守护进程，Node 单文件 dist-host/agent-hostd.cjs）
    ├─ 权限引擎 = 主应用 Permission.ts（同源同语义，ask → 审批广播，超时=拒绝）
    ├─ 工具域 21 个 = 主应用可移植模块组（file/terminal/git/web/memory/skill）
    ├─ Agent 循环 = 主应用 deepseek/agent-loop（electron 以 shim 替身提供）
    └─ 沙箱：任务串行 + cwd=工作区 + security-guard 写白名单
```

**关键文件地图**（本会话新增/修改）：

| 文件 | 说明 |
|---|---|
| `src/host/index.ts` | 守护进程入口 |
| `src/host/config.ts` | XDG 路径/config.json/token（环境变量 XIMO_HOST_*） |
| `src/host/protocol.ts` | cockpit-link v0 消息定义与校验 |
| `src/host/server.ts` | HTTP+WS 服务、鉴权、任务注册表、审批路由、串行队列、转录落盘 |
| `src/host/agent/task-runner.ts` | 复用主应用 agent-loop；chdir 工作区；写白名单；settings 引导 |
| `src/host/electron-shim.ts` | 纯 Node 运行主应用代码的 electron 替身（Module 钩子 + 别名重写） |
| `src/host/deploy/install.sh` | 双模式部署（systemd / WSL1 用户态，自动检测） |
| `src/host/deploy/ximo-host-wsl1.sh` | WSL1 启动器 start/stop/status/log/run |
| `src/host/deploy/agent-hostd.service` | systemd 单元（VM/裸机用） |
| `scripts/host-build.mjs` | esbuild 打包 → dist-host/agent-hostd.cjs（tsc 无法过 import.meta） |
| `os/**` | 镜像工程（mkosi/provision/build-image.sh/run-image-tcg.ps1/kernel 预案） |
| `.github/workflows/ximo-os-image.yml` | CI：构建镜像 + QEMU 引导冒烟 + 上传工件 |
| `src/main/tools/lazy-registry.ts` | +`ensureModuleGroupsLoaded`（host 复用工具域） |
| `src/main/tools/FileSystem/FileWriteTool.ts` | **安全修复**：接上写白名单检查（原先漏接） |
| `docs/ximo-os/PROTOCOL.md`、`docs/ENGINEERING.md`、`docs/TESTING.md` | 文档 |
| `tests/host/host.test.ts` | 10 个契约/安全集成用例 |
| `tests/functional/permission-desktop-subjects.test.ts` | 权限矩阵回归 |

**运行时复用链**：`agent-hostd` 直接 import `src/main` 与 `src/shared` 源码编译打包
（esbuild 别名 + 运行时钩子），**不要**把 host 拆成独立仓库——强耦合是刻意的。

## 4. 未完成工作清单（按优先级执行）

### P0-1 阶段 1 验收：CI 镜像实跑（预估 0.5 天）
- **做法**：`git push` 到 GitHub（workflow 已就绪，push master 或手动触发）→ 下载
  `ximo-os-0.1-raw` 工件 → 本机 `powershell os/scripts/run-image-tcg.ps1` 引导
- **验收**：`os/README.md` 的 5 项清单全勾（启动 ≤2min / journal 令牌 / health 200 /
  WS 派任务 completed / 审批路径）
- **坑**：Windows QEMU 从 qemu.weilnetz.de 装；串口控制台已配 `console=ttyS0`；
  root 密码锁死 → 进系统走 QEMU 控制台或给 firstboot 加密钥注入；
  CI 用 mkosi 24.3、WSL trixie 是 25.3——配置已双版本验证，但 CI 实跑为准

### P0-2 驾驶舱对接 UI（预估 2-4 天）——让系统真正可用
- 设置页新增"ximo-OS 主机"：地址 + 令牌（用 `/api/health` 验证连通），令牌走
  Windows 凭据管理器/safeStorage 存储
- `AgentSystemPanel` 增加"远程主机"数据源：REST `/api/tasks` 列表 + WS 事件实时刷新
- 聊天区：`task.chunk`(text) → 流式渲染；`(tool/tool_result)` → 复用现有工具卡片
- `approval.request` → 复用 `ConfirmDialog` → 回 `approval.respond`
- **坑**：preload API 分区在 `src/shared/preload-api/`；新增 IPC 通道后必须同步
  `tests/integration/ipc-contract.test.ts`（双向对账测试，漏了会红）
- **验收**：从 App 界面完成 派任务 → 流式 → 审批 → 完成 全流程

### P1-1 阶段 2：desktop-bus + 原生应用（预估 1-2 周）——"完全适配"的本体
- 已定设计：**headless-first**——桌面本体是 API 总线，GUI 只是渲染端之一
- **v1 内核已完成（2026-10-06 会话）**：`src/host/desktop/`（backend：xdotool/wmctrl
  执行层 + 命令构建/解析；bus：路由 + 2s 事件轮询）；协议 v1 增量
  `desktop.request/reply/event`（HOST_VERSION=1，类型在 shared/types/cockpit.ts，
  PROTOCOL.md 已同步）；主机 Agent 侧 `desktop` 工具（src/host/tools/desktop-tool.ts，
  task-runner 按总线可用性注册，Permission.ts 全量 allow）——驾驶舱（HostClient.
  desktopRequest）与主机 Agent 是同一总线的同等客户端。总线依赖主机侧 Xvfb
  （config.display，默认 :99，XIMO_HOST_DISPLAY 可覆盖，空 = 停用）
- **待做**：驾驶舱桌面面板（window.list/app.launch UI；事件经 host:event 已可透传）、
  画面流移植（wslcam:// 的 ffmpeg MJPEG 方案进镜像/主机）、文档/浏览器 app 的
  语义化 JSON API
- **验收**：同一办公任务纯 API 零截图完成（这是阶段 2 的灵魂指标）

### P1-2 视觉回路（✅ 已完成，2026-10-06 会话——走留存路径而非 image_url 直传）
- 实际断点：wsl_desktop 截图 base64 后即删文件，Agent 拿不到路径喂 vision_analyze
- 已修：截图 PNG 留存 Windows 临时目录（desktop-ops.ts，/mnt/c 挂载 + 24h 清理），
  工具结果携带 `vision_analyze(file_path=…)` 指引 + metadata.screenshotPath
- 未走 image_url 直传的原因：ContextManager/重建/tokenizer 均按纯字符串处理消息，
  且 tool 角色多模态的 DeepSeek 行为无法本地验证（400 风险）；若将来要做，先挂
  ProviderCapabilities 门控并在真实端点验证

### P1-3 人工接管（0.5-1 天；**先问用户要不要**，此前询问未获答复）
- 驾驶舱鼠标键盘 → cockpit-link v1 `input.*` 消息 → 镜像内 uinput/xdotool 注入；
  加"一键交还 Agent"开关

### P2-1 阶段 3（预估 1-2 周起）
- btrfs 快照回滚（任务前快照/一键还原）、eBPF 审计管线（预案见
  `os/kernel/README.md`）、按任务用户+沙箱加固、并发任务隔离（当前 runner 的
  chdir/写白名单是**进程级全局**，只能串行——并发需 worker 进程池或容器化）、
  裸机安装支持、NixOS 迁移评估

### P2 技术债（顺手修，均有记录）
- `tsconfig.web.json` 未 include `src/preload/extended-api.ts` → typecheck:web 报
  1 个 TS6307（修法：include 加该文件）
- `IconProps` 在渲染层两文件重复定义（AGENTS.md 6.4 违例）
- `src/host/deploy/agent-hostd.service` 与 `os/mkosi/provision/agent-hostd.service`
  双份（build 脚本优先前者；建议删后者防漂移）
- `scripts/test-vd*.ps1`、`vd-working.ps1` 是**前人遗留**（非本会话产物），去留自定
- WSL 内 `mate-polkit` dpkg 半残（apt 会报错但不影响构建）
- `tests/main/tools/office-docs-e2e.test.ts` 依赖真实 officecli，偶发失败，CI 建议
  对该文件重试

## 5. 验证命令（任何改动后必跑）

```bash
npm run typecheck        # 两个 tsconfig，必须 0 错误（web 有 1 个既有 TS6307 除外）
npx vitest run           # 43 文件 / 826 用例，必须全绿
npm run build            # Electron 主+渲染构建
npm run host:build       # agent-hostd.cjs（改 src/host 或其依赖后必跑）
# WSL1 冒烟（改 host 运行时后）：
wsl -d Debian -- bash -c "XIMO_REPO=/mnt/e/ximo2/ximo-Agent bash /mnt/e/ximo2/ximo-Agent/src/host/deploy/install.sh"
# 然后按 §2 命令重启并 curl health
```

## 6. 关键决策记录（有明确理由，勿轻易推翻）

1. **cockpit-link 宿主无关**：同一协议跑 WSL1/QEMU-TCG/云/裸机——无 VT-x 约束下
   唯一正确路线；镜像只是运行时的一种"壳"
2. **headless-first**：桌面本体是 desktop-bus API，本地屏幕只是渲染端之一；自研
   GUI 工程量因此收敛为"几个应用 + 一个渲染端"
3. **门面模式拆文件**：原路径保留 re-export，导入方零改动（10 个大文件已如此拆分）
4. **fail-closed**：审批超时=拒绝；无确认渠道=拒绝；绝不静默放行（AssistWatcher/
   host 审批/后台实例三处一致）
5. **权限同源**：host 直接 import 主应用 `Permission.ts`，审批文案不漂移
6. **esbuild 单文件打包 host**：tsc 的 CJS 目标无法编译依赖图里的 import.meta；
   产物 `.cjs` 后缀规避仓库 `"type": "module"`
7. **electron-shim 而非改源码**：主应用 electron 依赖面仅 `paths.ts`/`store.ts`，
   Module 钩子重定向即可让全部模块跑在纯 Node
8. **任务串行**：runner 的 cwd/写白名单是进程级全局，并发隔离属阶段 3（进程池/容器）
9. **FileWriteTool 已补写白名单检查**（security-guard 文档化意图 vs 实现脱节的
   安全修复，host 集成测试锁定）；白名单为空 = 放行（主应用旧行为不变）

## 7. 本会话已完成工作快照（避免重复劳动）

1. 全仓工程化规范：10 个超标文件拆分（门面模式），全部行数合规（§ENGINEERING.md）
2. 六类测试体系补全：826 用例全绿（功能/UI 组件 jsdom/模糊/回归/集成含 IPC 契约/
   冒烟）；修复 2 个真 bug（SAFE_CONFIG 漏 set_resolution、preload 死接口 confirm.request）
3. Agent 桌面系统"最后 5%"：drag/窗口管理/分辨率/审批补全/自愈/失败归因
4. 工作分摊功能（AssistWatcher）：感知→分析→弹窗征求→派发，8 用例
5. ximo-OS 阶段 0 + 0.5 + 镜像工程 + 无 VT-x 三层策略 + WSL1 实测部署（§3/§4）
6. FileWriteTool 安全修复（P2 技术债清单之外的真漏洞，测试锁定）
7. 打包 exe 后 Agent 桌面安装失败问题：根因是 UAC 路径静默失败 → 已修
   （bootstrap.ts 日志化 + 免提权直装），用户以管理员手动 `wsl --install -d Debian` 解锁
