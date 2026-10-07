# ximo-OS 深度落实开发 — 执行提示词

> 用途：本文件是给编程 Agent（或人类开发者）的**完整任务提示词**。新会话可全文粘贴，
> 或直接指示 Agent「读取 docs/ximo-os/DEVELOPMENT-PROMPT.md 并执行」。
> 产自 2026-10-07 深度复盘，所有缺陷靶点的 file:line 均经源码与 dist-host 产物核实。
> 行号以撰写时 HEAD 为准；若代码已演进，按符号名重新定位，不要盲改。

---

## 任务声明

你负责把 ximo-OS 从「演示可信」推进到「运行可信」。工作分四个阶段（A 止血与坐实 →
B 镜像与桌面汇合 → C 权限与协议可观测 → D 主航道能力）。路线与前提已定，你的职责是
**落实**，不是重新论证；实现中若发现与下述事实冲突的硬伤，停下来报告，不要擅自改路线。

每个子任务都有明确的「验证」标准——完成 = 验证命令通过，不是自我声明。

## 一、项目与环境（先读完，勿重新踩坑）

仓库 `E:\ximo2\ximo-Agent`（Windows 10 + Git Bash，Node v24，`"type": "module"`）含两个项目：

- **ximo-Agent**：已发布 v1.3.2 的 Electron 桌面 AI Agent（办公/编程/设计三模式）。
- **ximo-OS**：适配该 Agent 的 Linux OS。核心设计 **headless-first**：桌面本体是
  desktop-bus API 总线，GUI 只是渲染端。实现方式为移植而非重写：`electron-shim`
  （`src/host/electron-shim.ts`，Module._resolveFilename 钩子）让主应用可移植层
  （agent-loop / Permission / security-guard / store / 工具域）跑在裸 Node 上，
  esbuild 打包为单文件 `dist-host/agent-hostd.cjs`。

**环境硬约束（不要尝试绕过）**：

| 项 | 事实 |
|---|---|
| 虚拟化 | BIOS 无 VT-x → WSL2/Hyper-V/KVM 永久不可用；镜像引导验证只能靠 CI 的 QEMU TCG |
| WSL | 仅 Debian trixie 且是 WSL1（缺 open_tree()）→ 本地**不能** mkosi build，只能 `mkosi summary` 验证配置解析 |
| 主机常驻 | agent-hostd 部署在 WSL1 `/root/ximo-host/`，Windows 任务计划 `ximo-hostd` 保活；改配置后重启 = `schtasks /end` + `/run`（需 MSYS_NO_PATHCONV=1） |
| 网络 | git 代理 12450 已死；推送用 HANDOFF.md §7 决策 10 的降级链（gh CLI 稳定） |

WSL1/Git Bash 互操作坑（路径转换、/tmp 映射、pkill 模式等）全部记录在 HANDOFF.md §2，动手前先读。

**必读顺序**：`AGENTS.md`（硬规则，含行数上限/禁模拟数据）→ `docs/ENGINEERING.md` +
`docs/TESTING.md` → `HANDOFF.md` → `docs/ximo-os/PROTOCOL.md` → `os/README.md`。

## 二、已核实的缺陷靶点（本次工作的对象）

| # | 缺陷 | 位置 | 后果 |
|---|---|---|---|
| 1 | esbuild 把 `import.meta` 降级为 `{}`，skill 组 init 链抛 `TypeError: Invalid URL`，错误被 lazy-registry 吞掉，工具被 getByNames 静默过滤 | `src/main/tools/Skill/RrwebRecorder.ts:8`、`RrwebReplayer.ts:5`；bundle 内 `import_meta4={}`；`src/main/tools/lazy-registry.ts:250-253`（吞错）；`src/main/tools/ToolRegistry.ts:30-33`（静默过滤） | 生产主机上 `skill_record/skill_invoke/agent_expert/create_tool` 四个工具**从未注册** |
| 2 | 镜像 Packages 无任何 X 栈（无 xvfb/xdotool/wmctrl/xclip/ffmpeg/imagemagick） | `os/mkosi/mkosi.conf:27` | desktop-bus 在交付物（镜像）上不可运行，阶段 2 成果只存在于 WSL1 形态 |
| 3 | runCmd 失败归因缓存：正常空态也会置位（历史修复 2734d02 只点杀了剪贴板路径） | `src/host/desktop/bus.ts:284-299`（runCmd）；`active` 走 runCmd（:109-117）；`availableApps`（:212,216）；事件轮询 checkEvents | 无聚焦窗口查一次 `active` = 后续所有桌面操作快速失败（功能假死） |
| 4 | `coord()` 把非数字坐标静默归零 | `bus.ts:279-282` | `mouse.click {x:"abc"}` 静默点击 (0,0) |
| 5 | CI QEMU 冒烟 `continue-on-error: true` 且只探测 SSH 端口 | `.github/workflows/ximo-os-image.yml:53-62` | 镜像无法引导 CI 也不会红 |
| 6 | 三份手工清单零对账 + 死规则 | `src/host/agent/task-runner.ts:51-77`（HOST_TOOL_NAMES）；`src/main/tools/lazy-registry.ts:167-222`（modeToolNames）；`src/main/Permission.ts`（例：:99 的 code_execute ask 规则在主应用 coding 注册表无对应工具） | 清单漂移无报警；曾出现给从未注册的工具配权限（b9ee98c） |
| 7 | electron-shim 假成功兜底 + safeStorage 恒 false → 明文 apiKey 第二副本 | `src/host/electron-shim.ts:74,84-90`；`src/main/store.ts:47-54` | 未知 API 返回 no-op；settings.json 明文含密钥 |
| 8 | 协议：未知 t / 未知 desktop action → 断连而非协商；DESKTOP_ACTIONS 是单向类型约束 | `src/host/protocol.ts:41,49-50`；`src/host/server.ts:217-221`；`src/shared/types/cockpit.ts:106-110` | 版本偏斜表现为神秘断连；往 union 加成员漏加数组时 typecheck 不报错 |
| 9 | mkosi 配置静默忽略无校验（PostInstallationScripts 放错段不报错，已实锤过一次） | `os/scripts/build-image.sh` 与 CI 均无 `mkosi summary` 步骤 | 镜像「能引导但没有任何定制」曾长期未被发现 |

## 三、执行纪律（硬性，违反即返工）

1. **阶段门禁**：A 全绿（含门禁检查）才能进 B；C 可与 B 并行；D 的任何子项不得早于 A+B+C 完成。
2. **灭类纪律**：修任何一个 bug 时必须：(a) grep 全仓同型代码；(b) 至少加一道结构性防线
   （lint 规则 / 对账测试 / 类型穷举约束 / 构建期断言）。只点杀不灭类 = 未完成。
3. **禁新增静默失效**：catch 吞错必须注释归因理由；不得新增「返回假成功」的兜底；
   getByNames 式静默过滤不允许在新增代码中出现。
4. **每阶段末尾必跑**：`npm run typecheck`（0 错误）→ `npx vitest run`（全绿）→
   `npm run host:build`（且 A2 清点脚本通过）→ 主机改动后按 HANDOFF.md §8 重新部署并冒烟。
5. **红灯能力实测**：A 阶段结束做一次「验收的验收」——故意注入一处破坏（改坏一个工具
   工厂名 / 删一条 allow），确认新防线真的会红，然后还原并记录。
6. **协议纪律**：字段只增不改；新增 `t` 类型 → HOST_VERSION+1；消息类型单一来源
   `src/shared/types/cockpit.ts`。
7. **项目性质**：生产级，**禁止模拟数据**（AGENTS.md §5）；精准修改，不动无关代码（AGENTS.md §3）。
8. **跨会话接力**：若单次会话做不完全部阶段，做到子任务边界为止，把进度/剩余项/新踩的坑
   写进 HANDOFF.md 再结束；禁止烂尾式收尾。
9. **提交规范**：每个子任务独立 commit，消息沿用仓库现有中文风格（`fix: …` / `阶段 N：…`）；
   每阶段结束更新 HANDOFF.md（完成清单、新坑、验证命令变化）。

## 四、阶段 A：止血与坐实（预计 1–2 天）

### A1 修 skill 组加载断裂 + 灭类 lint（~1h）
- `RrwebRecorder.ts:8`、`RrwebReplayer.ts:5` 的 `fileURLToPath(new URL('.', import.meta.url))`
  改为 CJS `__dirname` 写法——**现成参照**：`src/host/tools/office-docs-tool.ts:27-33`
  （同型 bug 在那里已修过并写明原因）。
- 灭类：全仓 grep `import.meta` 确认 host 依赖图（HOST_TOOL_GROUPS 能到达的模块）无残留；
  加 eslint `no-restricted-syntax` 规则禁止 host 构建路径使用 `import.meta.url`。
- 验证：`npm run host:build` → A2 清点脚本全量注册通过。

### A2 产物工具清点脚本（~1h）
- 新增 `scripts/host-verify.mjs`（或挂进 host:build 尾部）：node 直接 require
  `dist-host/agent-hostd.cjs`（自挂 shim），调用 `ensureModuleGroupsLoaded(HOST_TOOL_GROUPS)`，
  断言 `toolRegistry` 注册数 == `HOST_TOOL_NAMES.length`，diff 打印缺失/多余。
- 验证：故意改坏 lazy-registry 一个工厂名 → 脚本红灯 → 还原。

### A3 runCmd 归因缓存与坐标强转（~1h）
- runCmd：区分「正常空态 rc=1」（getactivewindow 无聚焦、xclip 空读）与真故障；
  正常态不得写 `unavailableReason`。覆盖 active / availableApps / checkEvents 全部调用点。
- `coord()`：非数字坐标改为抛参数错误（desktop.reply ok:false），不归零。
- 灭类：grep runCmd 全部调用点，逐一归类「正常空态 / 真故障」并注释。
- 验证：新增单测——「空态不置缓存」「坏坐标报错且不点击」。

### A4 CI 冒烟升级 + mkosi 校验（~1h）
- ximo-os-image.yml：移除 `continue-on-error`；冒烟断言升级为 health 200 → WS 派任务 →
  `task.done(completed)`；接入 `os/scripts/verify-image.mjs` 的 5 项检查。
- build-image.sh：构建前 `mkosi summary` 并断言 PostInstallationScripts / Packages 解析非空。
- 验证：完整 CI run 全绿；A5 后做红灯实测（纪律 5）。

### A5 Xvfb 在环集成测试（~半天）
- 新 CI job（ubuntu-latest）：`apt install xvfb xdotool wmctrl xclip imagemagick`，
  `xvfb-run` 下真实驱动 DesktopBus：window.list / app.launch / active / key / type /
  clipboard.read/write / 事件轮询。真机怪癖（rc=1 正常态、十六进制窗口 id、空剪贴板）
  直接暴露在断言里。现有 fake 后端单测保留为单元层。
- 验证：CI 全绿 + 红灯实测通过。

**阶段 A 门禁**：A1–A5 全绿 + 红灯实测有记录 + HANDOFF.md 已更新。

## 五、阶段 B：镜像与桌面汇合（预计 2–4 天）

**B0 已拍板：镜像 0.2 承载桌面栈**（理由：desktop-bus 是项目核心资产，镜像不承载 =
适配度封顶 60%，且文档与产物长期矛盾）。体积预算：Packages 增量 ≤200MB，超预算停下问用户。

### B1 镜像加桌面栈（~1 天）
- mkosi.conf Packages 追加：`xvfb,openbox,xdotool,wmctrl,xclip,ffmpeg,imagemagick`
  （轻量 WM，不上完整桌面环境）。
- 新增 systemd 模板单元（如 `xvfb@.service`）托管 Xvfb + openbox 会话；
  `agent-hostd.service` 加 After/Requires；display 经环境变量（如 `XIMO_DISPLAY=:99`）注入。
- 验证：CI 构建成功；引导后确认 X 进程存活、`desktop.request screen.size` 有值。

### B2 镜像级桌面冒烟（~1 天）
- CI 引导后派纯 API 桌面任务：`app.available → app.launch → window.list → key →
  clipboard.write/read`，断言全部 ok——这是 headless-first 论断在交付物上的第一次真实成立。
- 验证：CI 全绿且任务 completed；HANDOFF 更新镜像体积实测数据。

### B3 SSH 密钥注入自动化（可选，~半天）
- firstboot 支持从内核 cmdline 或挂载介质读取公钥注入 authorized_keys，
  消除验收流程中唯一的人工环节。

## 六、阶段 C：权限与协议可观测（预计 1–2 天，可与 B 并行）

### C1 权限矩阵自检 + 默认决策场景化
- 主机启动时打印「工具 × 决策」矩阵并 diff 预期清单。
- `defaultDecision` 从清单配置抽为运行时参数：主机显式注入 `deny` 并在日志声明
  （无人值守语义显式化），主应用保持 `ask`。默认回退首次触发 → warn + 计数。
- 验证：新增单测；主机启动日志含矩阵与回退计数。

### C2 三方对账测试 + 死规则清理
- 新对账测试：HOST_TOOL_NAMES ↔ lazy-registry 注册表 ↔ Permission 规则引用的工具名，
  引用了两侧都不存在的工具名的规则 → 报错（或警告清单）。
- 清理现存死规则（主机侧永不注册的 wsl_desktop 全家/virtual_desktop/browser_*；
  主应用 coding ask 的 code_execute——确认是缺注册还是多余规则，缺则补、多则删）。
- 验证：对账测试全绿；Permission.ts 无死规则。

### C3 协议加固
- `cockpit.ts`：DESKTOP_ACTIONS 加 `satisfies` 穷举约束（新增 action 漏加数组 → typecheck 报错）。
- `hello` 消息追加主机支持的 action 列表（字段只增）；HostClient 据此做降级提示而非靠断连发现。
- `server.ts`：未知 desktop action 从「断连」改为 `desktop.reply(ok:false, error:'unsupported_action')`；
  未知 `t` 维持断连（协议级错误语义不变）。
- 验证：协议测试覆盖三类偏斜场景（新 action 新主机/旧主机、新 t、坏参数）。

### C4 electron-shim 严格模式
- 环境变量（如 `XIMO_SHIM_STRICT=1`，主机生产默认开）：未知顶层 electron API 抛错而非 no-op；
  主应用路径维持宽松模式。
- 排查嵌套缺失成员（Proxy 只包一层）：重点 `BrowserWindow.getFocusedWindow`
  （`src/main/tools/Browser/WebviewBridge.ts:73`）——补齐 shim 或隔离调用路径。
- `store.ts`：主机路径禁止明文写 apiKey（isEncryptionAvailable=false 时敏感字段报错或跳过写盘，
  二选一并注释理由）。
- 验证：A2 清点 + 冒烟在严格模式下仍全绿（证明 bundle 的 electron 依赖面真的全覆盖）。

## 七、阶段 D：主航道能力（A+B+C 完成后按序执行）

### D1 浏览器语义化 API —— 技术路径已定：CDP 直连，**禁止 playwright**
- 镜像加 chromium，`--remote-debugging-port=9222` 启动；主机侧用 Node 原生 ws 实现 CDP
  客户端，起步六原语：navigate / click / type / screenshot / evaluate / 内容提取，
  注册为 `browser` 工具域。理由：与 electron-shim「最小接缝」同哲学，避免 playwright
  体积与依赖复杂化镜像。GUI 兜底仍走 desktop-bus。
- 验证：Agent 零截图完成「浏览器内搜索并提取结果标题」E2E。

### D2 并发隔离 = worker 进程池
- 每任务 fork 子进程跑 runTask（chdir/写白名单随进程天然隔离），主进程只做队列/WS/广播。
- 灭类：消除 `task-runner.ts:193-194` 的 chdir 残留单点（finally 恢复失败时的状态污染）。
- 验证：新集成测试证明两任务并发互不污染工作区。

### D3 人工接管 input.*
- 协议加 `input.move/click/key/type`（HOST_VERSION → 2，遵守版本纪律）；驾驶舱桌面面板
  接现有键鼠 UI；权限上 input.* 默认 ask（有人在场的语义与无人值守区分）。
- 验证：驾驶舱鼠标点击镜像内真实窗口生效。

### D4 office_docs 旧格式与排版
- LibreOffice headless **仅装镜像、仅用于转换**（.doc/.xls/.ppt → OOXML 与排版导出）；
  主机 Node 运行时不引入 LibreOffice 依赖。
- 验证：旧格式文件读取 E2E。

### D5 阶段 3：快照 / 沙箱 / 审计
- btrfs 快照：root 分区改 btrfs，firstboot 建子卷布局，任务前后打快照点。
- **按任务用户沙箱与 D2 进程池合并设计**（每任务 = 专用用户 + 专用进程），不要做成两套系统。
- eBPF 审计最后做。
- 验证：回滚 E2E（改坏工作区 → 快照回滚 → 内容恢复）。

## 八、明确不做

- 不尝试本机装 QEMU / 升级 WSL2 / 任何虚拟化路线（硬约束，永久不可用）。
- 不把 playwright / pip 引入主机 Node 运行时；LibreOffice 只进镜像且只做转换。
- 不写任何模拟数据冒充真实数据源（AGENTS.md §5）。
- 不重构与靶点无关的代码，不顺手「改进」（AGENTS.md §3）。
- 不在 A/B/C 未完成时启动 D。

## 九、完成定义

- 全部阶段的验证标准通过，红灯实测有记录（防线真的能拦住注入的破坏）。
- HANDOFF.md 交接完整：完成清单 / 新踩的坑 / 验证命令变化 / 下一步。
- 适配度自评表更新（对照锚点，均为估计值：A 后 ~68%，B 后 ~80%，D1+D2 后 ~90%）。
