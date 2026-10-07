/**
 * cockpit-link v0 协议消息 — 主机与驾驶舱之间的唯一契约
 *
 * 消息类型已下沉到 @shared/types/cockpit（主进程 HostClient / 渲染层面板 / 主机
 * server 三方共用），此处只保留主机侧独有的**运行时校验**：把不可信的 WS 文本帧
 * 解析成 ClientMsg，非法帧返回 null（调用方回 error 帧并断开）。
 *
 * 传输：WS 文本帧（JSON）；REST 仅做任务查询。
 * 版本策略：字段只增不改；驾驶舱按 hello.version 决定兼容性。
 * 完整语义见 docs/ximo-os/PROTOCOL.md。
 */
export type {
  TaskDispatchMsg, TaskCancelMsg, ApprovalRespondMsg, PingMsg, ClientMsg,
  HelloMsg, TaskAcceptedMsg, TaskStatusMsg, TaskChunkDelta, TaskChunkMsg,
  ApprovalRequestMsg, TaskDoneMsg, ErrorMsg, PongMsg, HostMsg,
} from '../shared/types/cockpit'
export { HOST_VERSION } from '../shared/types/cockpit'

import { type ClientMsg, type DesktopAction } from '../shared/types/cockpit'

/** 解析并校验客户端消息 — 非法返回 null（调用方回 error 帧并断开） */
export function parseClientMsg(raw: string): ClientMsg | null {
  let v: unknown
  try { v = JSON.parse(raw) } catch { return null }
  if (typeof v !== 'object' || v === null) return null
  const m = v as Record<string, unknown>
  if (typeof m.t !== 'string') return null
  switch (m.t) {
    case 'task.dispatch':
      return typeof m.task === 'string' && m.task.trim()
        ? { t: 'task.dispatch', id: typeof m.id === 'string' ? m.id : undefined, task: m.task, mode: typeof m.mode === 'string' ? m.mode : undefined }
        : null
    case 'task.cancel':
      return typeof m.id === 'string' ? { t: 'task.cancel', id: m.id } : null
    case 'approval.respond':
      return typeof m.reqId === 'string' && typeof m.allow === 'boolean'
        ? { t: 'approval.respond', reqId: m.reqId, allow: m.allow }
        : null
    case 'desktop.request': {
      // 注意：action 的合法性**不在此校验**——未知动作放行到 DesktopBus.dispatch
      // 的 default 分支抛错，由 server 转成 desktop.reply(ok:false)。
      // 在这里拒绝会导致「驾驶舱新增动作 + 主机未升级」表现为整条连接被切断，
      // 而不是一次可恢复的动作级失败。
      if (typeof m.reqId !== 'string' || typeof m.action !== 'string') return null
      const params = typeof m.params === 'object' && m.params !== null
        ? m.params as Record<string, unknown>
        : undefined
      return { t: 'desktop.request', reqId: m.reqId, action: m.action as DesktopAction, params }
    }
    case 'ping':
      return { t: 'ping' }
    default:
      return null
  }
}
