# cockpit-link 协议 — 驾驶舱 ↔ ximo-OS 主机

> 这是驾驶舱（Windows Electron App / 任何客户端）与 ximo-OS 主机（agent-hostd）之间的**唯一契约**。
> 协议定稳后两端并行开发；字段只增不改，破坏性变更升版本号。
> 当前版本：**v1**（v0 基础上新增 `desktop.*` 消息，v0 消息原样保留）。

## 1. 传输与鉴权

| 项 | 约定 |
|---|---|
| 控制通道 | `ws://<host>:17890/ws?token=<令牌>`（或 `Authorization: Bearer <令牌>` 头） |
| 查询通道 | `GET /api/health`、`GET /api/tasks`，同样 Bearer 鉴权 |
| 令牌 | 主机首次启动生成（0600），只回显一次；泄露即删文件重启生成 |
| 心跳 | 客户端发 `{"t":"ping"}` → 主机回 `{"t":"pong"}` |
| 消息编码 | WS 文本帧，UTF-8 JSON，`t` 字段为消息类型 |

## 2. 消息一览

**驾驶舱 → 主机**

| t | 字段 | 说明 |
|---|---|---|
| `task.dispatch` | `id?` `task` `mode?` | 派任务；`id` 为幂等键，缺省主机生成 |
| `task.cancel` | `id` | 取消运行中的任务（AbortController 级联中止 LLM 与工具） |
| `approval.respond` | `reqId` `allow` | 回应审批请求；`false` 或超时（默认 120s）= 拒绝 |
| `desktop.request` | `reqId` `action` `params?` | desktop-bus 调用（v1）；action 见下表 |
| `ping` | — | 心跳 |

**主机 → 驾驶舱**

| t | 字段 | 说明 |
|---|---|---|
| `hello` | `version` `name` | 连接建立后的第一条消息 |
| `task.accepted` | `id` | 任务受理（含幂等冲突时改发 `error`） |
| `task.status` | `id` `stage` | `running` / `awaiting_approval` |
| `task.chunk` | `id` `seq` `delta` | 增量流：`text`（LLM 文本）/ `tool`（调工具）/ `tool_result`（工具结果） |
| `approval.request` | `reqId` `id` `tool` `summary` | ask 类操作征求同意（fail-closed：超时=拒绝） |
| `task.done` | `id` `status` `result` `error?` | 终态：`completed` / `failed` / `cancelled` |
| `desktop.reply` | `reqId` `ok` `data?` `error?` | desktop.request 的应答（v1） |
| `desktop.event` | `kind` `data` | 窗口/应用变化推送，data 为变化后完整快照（v1） |
| `error` | `code` `message` | 协议级错误（坏消息/重复 id 等）；坏帧后主机会断开该连接 |

### desktop-bus action 表（v1）

| action | params | data |
|---|---|---|
| `window.list` | — | `DesktopWindow[]`（id/pid/app/title/x/y/w/h，结构化窗口树） |
| `window.op` | `op` `window_id?` `title?` `x? y? w? h?` | `{ done: true }` |
| `app.launch` | `app` `args?` | `{ pid }` |
| `app.list` | — | `{ app, pid, windows: DesktopWindow[] }[]` |
| `key` | `keys`（如 "ctrl+s"） | `{ done: true }` |
| `type` | `text` | `{ done: true }` |
| `active` | — | `DesktopWindow \| null` |
| `mouse.move` | `x` `y` | `{}` |
| `mouse.click` | `x` `y` `button?`（left/middle/right） | `{}` |
| `mouse.scroll` | `x?` `y?` `direction`（up/down/left/right） `amount?` | `{}` |
| `screen.size` | — | `{ width, height }`（交互坐标映射用） |

### 桌面画面通道（v1，REST，Bearer 鉴权）

| 端点 | 说明 |
|---|---|
| `GET /api/screen/stream` | ffmpeg MJPEG 实时画面流（`multipart/x-mixed-replace`）；驾驶舱经 `ximo-host-cam://` 协议代理给 `<img>` |
| `GET /api/screen/snapshot` | 单帧截图 `{ ok, screenshot }`（base64 data URL）——画面流不可用时的兜底渲染源 |

## 3. 关键时序

```
正常执行：
  → task.dispatch          ← task.accepted
  ← task.chunk*(text)      ← task.chunk(tool) ← task.chunk(tool_result)*
  ← task.done(completed)

需要审批（如 terminal_exec）：
  ← task.status(awaiting_approval)
  ← approval.request(reqId)
  → approval.respond(allow=true|false)
  ← task.status(running)   ← task.chunk(tool_result)
  （无响应 120s → 视为拒绝，工具收到"用户拒绝"继续运行）

桌面调用（v1）：
  → desktop.request(reqId, action, params)   ← desktop.reply(reqId, ok, data)
  ← desktop.event(kind, data)                （窗口/应用变化主动推送）

取消：
  → task.cancel            ← task.done(cancelled)
```

## 4. 安全语义（契约级，两端共同遵守）

1. **fail-closed**：审批拿不到响应 = 拒绝；无任何旁路放行。
2. **权限引擎同源**：主机侧使用与主应用相同的 allow/ask/deny 规则（`src/main/Permission.ts`），驾驶舱展示的审批文案不漂移。
3. **沙箱**：文件工具锁死任务工作区；`web_fetch` 复用主应用 SSRF 防护；终端命令经审批。
4. **控制面唯一**：驾驶舱对主机的全部影响只经本协议；主机不出站连接驾驶舱。

## 5. 驾驶舱对接点（现有 Electron App）

- 新增设置：主机地址 + 令牌（连接测试走 `/api/health`）
- `task.chunk` 的 text → 聊天流式渲染；tool/tool_result → 复用现有工具卡片
- `approval.request` → 复用现有 ConfirmDialog 交互，回 `approval.respond`
- 实例列表复用 AgentSystemPanel 形态，数据源换 `/api/tasks` + WS 事件

## 6. 版本

- `hello.version = 1`（当前；v0 = 基础任务协议，v1 增量 `desktop.*`）
- 兼容规则：新字段可忽略；新增 `t` 类型时 version +1 之前的消息不得删除或改义
