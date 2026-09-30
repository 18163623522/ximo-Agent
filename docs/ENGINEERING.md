# ENGINEERING.md — 工程规范与接手指南

> 面向接手本项目的工程师。读完这页，你应该知道代码住在哪里、为什么住在那里、以及加新功能时该动哪些文件。
> 行数硬性上限与拆分规则见根目录 `AGENTS.md` 第 6 节，本文件是它的项目化落地版。

## 1. 技术栈与三大进程

| 进程 | 目录 | 职责 |
|---|---|---|
| Main（主进程） | `src/main/` | Electron 主进程：Agent 循环、工具执行、权限、存储、调度、系统操作 |
| Preload（桥接层） | `src/preload/` + `src/shared/preload-api/` | `contextBridge` 暴露 `window.api`，只做 IPC 转发，零业务逻辑 |
| Renderer（渲染层） | `src/renderer/` | React UI：三模式布局、面板、聊天输入区 |
| 共享 | `src/shared/` | 两端共用的类型、常量、上下文压缩算法、范式提示词 |

## 2. 行数上限（硬性，AGENTS.md 6.1）

| 类型 | 上限 | 当前状态 |
|---|---|---|
| UI 组件 `.tsx` | 400 | ✅ 全部达标 |
| 状态管理 | 500 | ✅ |
| 工具类 / 服务层 | 400 | ✅ |
| 类型定义 | 600 | ✅ |
| 其他 `.ts` | 300 | ✅ |

任何 PR 新增文件超限必须先拆再合。拆分用**门面模式**：原路径保留为门面（re-export 或薄编排），保证导入方零改动。

## 3. 目录地图（关键模块）

### src/main/
```
index.ts                    # 启动编排：协议、窗口、IPC 注册（只做编排，无业务）
AssistWatcher.ts            # 工作分摊感知器（感知→分析→弹窗征求→派发）
AgentSystemStore.ts         # Agent 独立系统编排层（实例引擎/互斥队列/Webhook），≤400 行
AgentSystem/                # 上面这块的存储与上下文拆分
  DefinitionStore.ts        #   Agent 定义库 CRUD
  InstanceRegistry.ts       #   实例注册表（持久化/裁剪/迁移）
  work-context.ts           #   "主人近期工作上下文"构建
ScheduleStore.ts            # 定时任务调度器（30s tick，主进程直派）
Permission.ts               # 权限引擎：allow/ask/deny 规则，deny > ask > allow
security-guard.ts           # 写白名单 / 敏感文件拦截 / SSRF 防护
ipc/                        # IPC 注册器按域拆分：chat-stream / agent-task / workspace / window-handlers 等
  chat-handler.ts           #   编排器（20 行），按原顺序调用子注册器
  system-handlers.ts        #   编排器（28 行），末尾含调度器/Webhook/AssistWatcher 启动引导
deepseek/                   # Agent 循环：agent-loop / tool-execution / tool-permissions / supervisor
tools/                      # 每个工具一个目录，目录内 index.ts 为唯一出口
  AgentWorkspace/           #   WSL 隔离桌面：manager(编排/门闩) + wsl-exec(原语) + bootstrap(引导) + desktop-ops(操作) + init-script(脚本)
  VirtualDesktop/           #   Windows 虚拟桌面：manager(编排) + commands(PowerShell/C#) + types
  Skill/sub-agent.ts        #   子 Agent 循环（权限与主链路同源）
```

### src/preload/ + src/shared/preload-api/
```
preload/index.ts            # 门面（~50 行）：组装 api 对象 + exposeInMainWorld + export type Api
shared/preload-api/*.ts     # 按域分组的部分 api 对象（chat/data/shell/files/browser/computer/agent）
                            # 落位在 shared/ 是因为 web 工程 composite include 只认 src/preload/index.ts 单文件
```
新增 IPC 通道：先在 main 侧 `ipcMain.handle`（放对应域的 handler 文件），再在 `shared/preload-api/` 对应域文件加一行 invoke，通道名字符串两端一致。

### src/renderer/
```
store/                      # useStore（zustand）+ runStream（流处理）+ buildApiMessages/（请求消息构建）
hooks/                      # useVoiceDiscussion/ 等复杂 hook 拆为子目录（门面 re-export）
components/
  chat-input/               # 聊天输入区（工具栏/选择器已按组件拆分）
  panels/                   # 功能面板：AgentSystemPanel/ 内含 InstancesTab/SchedulesTab/DefinitionsTab/AssistToggle
  settings/                 # 设置弹窗及其分节
  desktop/                  # Agent 桌面面板
  message/                  # 消息渲染
lib/transcriptAdapter/      # 会话消息 → 展示转录的适配层（解析/有序化/格式化分文件）
modes/                      # 模式提示词
```

### src/shared/
```
types/                      # 全部共享类型（settings.ts 为 AppSettings 单一来源）
defaults.ts                 # DEFAULT_SETTINGS 单一来源
cache/                      # 四档上下文压缩算法（主/子 Agent 共用）
glm-paradigm/               # GLM 范式提示词（core/workflow/standards/endurance + index 门面）
agent-definition.ts         # Agent 定义/实例类型 + 种子数据
agent-schedule.ts           # 定时任务类型 + 归一化
```

## 4. 必须遵守的约定

1. **门面模式**：拆文件时原路径继续导出原有符号（`export { x } from './子模块'`），导入方零改动。改动面最小、PR 最好审。
2. **可变状态单点**：单例类（Store/Manager）持有全部可变状态；抽出的模块是无状态纯函数或接收参数的工厂。两个模块不共享可变 `let`。
3. **IPC 通道名是契约**：`'chat:start'` 这类字符串在 main 与 preload 各出现一次，改名 = 两端同改 + 手测。
4. **导入路径**：渲染层跨目录用别名（`@renderer/`、`@shared/`），主进程同目录相对、跨目录 `@main/`；同一文件不混用别名与相对路径。
5. **权限三闸门**：新工具必须在 `Permission.ts` 声明 allow/ask/deny（漏声明会落到 defaultDecision——coding/office 是 ask，会莫名单弹确认框）；危险动作同时挂 `security-guard`。
6. **fail-closed**：任何"需要用户确认但拿不到确认渠道"的场景（后台实例、无头运行）一律拒绝执行并记录，绝不静默放行。
7. **Agent 实例结果写回会话后必须推 `conversation:updated`**，否则渲染层下一次全量持久化会覆盖丢数据（历史教训，见 AgentSystemStore 注释）。

## 5. 加新功能的常规路径

- **新工具**：`src/main/tools/<域>/XxxTool.ts`（≤400 行）→ 域 `index.ts` 导出 → `lazy-registry.ts` 注册模块组与 `modeToolNames` → `Permission.ts` 加权限条目。
- **新 IPC 通道**：`src/main/ipc/<域>-handlers.ts` → 对应编排器加一行注册调用 → `shared/preload-api/` 加 invoke → `preload/index.ts` 无需改（展开自动并入 Api 类型）。
- **新面板**：`components/panels/XxxPanel.tsx` → 超过 250 行时同目录建 `XxxPanel/` 子目录放子组件与 constants。
- **新后台 Agent 类型**：复用 `AgentSystemStore.startInstance` + `@shared/agent-definition.ts`，不要另起执行引擎。

## 6. 验证命令（改完必跑）

```bash
npx tsc --noEmit -p tsconfig.node.json   # 主进程 + preload + shared（必须 0 错误）
npx tsc --noEmit -p tsconfig.web.json    # 渲染层（当前仅 1 个既有 TS6307 配置错误，见下）
npx vitest run                           # 渲染层单测（transcript-order / build-api-messages 等）
npm run build                            # electron-vite 全量构建（必须成功）
```

## 7. 已知技术债（接手后可择机处理）

1. `tsconfig.web.json` 显式 include 了 `src/preload/index.ts` 但未包含其 import 的 `extended-api.ts` → `tsc -p tsconfig.web.json` 报 1 个 TS6307。修法：include 加 `src/preload/extended-api.ts`（或去掉对 preload 的直接 include，经 node 工程校验）。
2. `IconProps` 接口在渲染层两个文件中重复定义（AGENTS.md 6.4），未影响行为，建议合并到共享 types。
3. 渲染层 `ToolResult.screenshot` 未接入模型消息流（多模态感知回路未打通），属功能缺口而非规范问题。
