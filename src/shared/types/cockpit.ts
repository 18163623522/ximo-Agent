// ====== cockpit-link 协议 — 驾驶舱（Electron App）↔ ximo-OS 主机（agent-hostd）======
//
// 契约全文见 docs/ximo-os/PROTOCOL.md。类型下沉到 shared 的目的：主进程 HostClient、
// 渲染层远程主机面板、主机端 server 三方共用一份定义，字段漂移立即被 typecheck 拦住。
// 版本策略：字段只增不改；新增 `t` 类型时 version +1，旧消息不得删除或改义。

/** 主机协议版本 — 驾驶舱按 hello.version 决定兼容性 */
export const HOST_VERSION = 0

// ---------- 驾驶舱 → 主机 ----------

export interface TaskDispatchMsg {
  t: 'task.dispatch'
  /** 驾驶舱生成的任务 id（幂等键）；也可不填由主机生成 */
  id?: string
  task: string
  /** 权限模式，缺省用主机配置 */
  mode?: string
}

export interface TaskCancelMsg { t: 'task.cancel'; id: string }

export interface ApprovalRespondMsg { t: 'approval.respond'; reqId: string; allow: boolean }

export interface PingMsg { t: 'ping' }

export type ClientMsg = TaskDispatchMsg | TaskCancelMsg | ApprovalRespondMsg | PingMsg

// ---------- 主机 → 驾驶舱 ----------

export interface HelloMsg {
  t: 'hello'
  version: number
  name: string
}

export interface TaskAcceptedMsg { t: 'task.accepted'; id: string }

export interface TaskStatusMsg {
  t: 'task.status'
  id: string
  stage: 'queued' | 'running' | 'awaiting_approval' | 'completed' | 'failed' | 'cancelled'
}

/** 任务增量事件 — 主机侧 runner 产出，随 task.chunk 传输 */
export type RunnerEvent =
  | { type: 'text'; text: string }
  | { type: 'tool'; name: string; argsSummary: string }
  | { type: 'tool_result'; name: string; content: string; success: boolean }

export type TaskChunkDelta = RunnerEvent

export interface TaskChunkMsg {
  t: 'task.chunk'
  id: string
  seq: number
  delta: TaskChunkDelta
}

export interface ApprovalRequestMsg {
  t: 'approval.request'
  reqId: string
  id: string
  tool: string
  summary: string
}

export interface TaskDoneMsg {
  t: 'task.done'
  id: string
  status: 'completed' | 'failed' | 'cancelled'
  result: string
  error?: string
}

export interface ErrorMsg { t: 'error'; code: string; message: string }

export interface PongMsg { t: 'pong' }

export type HostMsg = HelloMsg | TaskAcceptedMsg | TaskStatusMsg | TaskChunkMsg
  | ApprovalRequestMsg | TaskDoneMsg | ErrorMsg | PongMsg

// ---------- REST 查询通道 ----------

/** 主机任务记录 — REST /api/tasks 与 WS 增量共同描述同一实体 */
export interface HostTaskRecord {
  id: string
  task: string
  status: 'queued' | 'running' | 'awaiting_approval' | 'completed' | 'failed' | 'cancelled'
  chunks: RunnerEvent[]
  result: string
  error?: string
  createdAt: number
  finishedAt?: number
}

/** GET /api/health 响应 */
export interface HostHealth {
  ok: boolean
  name?: string
  version?: number
  mode?: string
  error?: string
}

// ---------- 驾驶舱侧连接状态 ----------

export type HostStatus = 'disconnected' | 'connecting' | 'connected' | 'error'

export interface HostStatusInfo {
  status: HostStatus
  /** 连接目标地址（脱敏后，不含令牌） */
  url: string
  /** 最近一次失败原因 */
  error?: string
}
