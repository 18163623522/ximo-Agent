/**
 * HostClient — 驾驶舱侧 cockpit-link 客户端（主进程）
 *
 * 职责：与 ximo-OS 主机（agent-hostd）建立并维持 WebSocket 连接，把主机的
 * 任务事件、审批请求、连接状态转发给渲染进程；提供 REST 查询与派任务/取消/
 * 审批应答的控制面方法。
 *
 * 设计约束：
 * - 不 import electron —— 事件投递通过注入的 emit 回调，便于单测直接驱动
 * - 断线指数退避重连（封顶），主动 disconnect 后不再重连
 * - 心跳：定时 ping，超时未收到任何帧则判定连接已死并重连
 * - 任务视图：本地维护任务表（由 accepted/chunk/status/done 增量更新），
 *   变更即推送快照，渲染层无需自行重建状态机
 */
import WebSocket from 'ws'
import type {
  ClientMsg, HostMsg, HostTaskRecord, HostHealth, HostStatusInfo, RunnerEvent,
} from '@shared/types'
import { HOST_VERSION } from '@shared/types'

/** 事件投递回调 — 生产环境接 BrowserWindow.webContents.send，单测接收集器 */
export interface HostEmit {
  /** 连接状态变更 */
  status: (s: HostStatusInfo) => void
  /** 任务表快照（增量更新后推送全量，渲染层无需自建状态机） */
  tasks: (tasks: HostTaskRecord[]) => void
  /** 主机原始帧 — 渲染层用于转录流式渲染与审批弹窗 */
  event: (m: HostMsg) => void
}

const RECONNECT_BASE_MS = 1000
const RECONNECT_MAX_MS = 30_000
const HEARTBEAT_MS = 20_000
/** 心跳后等待任何帧的宽限 — 超过则认为连接已死 */
const HEARTBEAT_GRACE_MS = 10_000
const DISPATCH_TIMEOUT_MS = 10_000

interface PendingDispatch {
  resolve: (v: { ok: boolean; id?: string; error?: string }) => void
  timer: ReturnType<typeof setTimeout>
}

export class HostClient {
  private ws: WebSocket | null = null
  private url = ''
  private token = ''
  private status: HostStatusInfo = { status: 'disconnected', url: '' }
  private tasks = new Map<string, HostTaskRecord>()
  private pendingDispatch = new Map<string, PendingDispatch>()
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null
  private graceTimer: ReturnType<typeof setTimeout> | null = null
  private reconnectAttempt = 0
  /** 主动断开标记 — 抑制重连 */
  private intentionalClose = false

  constructor(private readonly emit: HostEmit) {}

  // ------------------------------------------------------------------
  // 连接生命周期
  // ------------------------------------------------------------------

  /** 配置并连接 — url 形如 http://127.0.0.1:17890 或 ws://... /ws（自动归一化） */
  connect(url: string, token: string): void {
    this.teardown()
    this.url = url.trim()
    this.token = token.trim()
    this.intentionalClose = false
    this.reconnectAttempt = 0
    if (!this.url || !this.token) {
      this.setStatus({ status: 'disconnected', url: this.url, error: '未配置主机地址或令牌' })
      return
    }
    this.open()
  }

  /** 主动断开（停止重连） */
  disconnect(): void {
    this.intentionalClose = true
    this.teardown()
    this.setStatus({ status: 'disconnected', url: this.url })
  }

  getStatus(): HostStatusInfo {
    return { ...this.status }
  }

  isConnected(): boolean {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN
  }

  private setStatus(next: HostStatusInfo): void {
    // 地址脱敏 — 令牌只出现在 query 里，状态对外只暴露 host:port
    this.status = { ...next, url: safeUrlLabel(this.url) }
    this.emit.status(this.status)
  }

  private open(): void {
    this.setStatus({ status: 'connecting', url: this.url })
    let ws: WebSocket
    try {
      ws = new WebSocket(wsUrl(this.url), { headers: { Authorization: `Bearer ${this.token}` } })
    } catch (e) {
      this.scheduleReconnect((e as Error).message)
      return
    }
    this.ws = ws

    ws.on('open', () => {
      this.reconnectAttempt = 0
      this.setStatus({ status: 'connected', url: this.url })
      this.startHeartbeat()
    })
    ws.on('message', (raw) => this.handleMessage(String(raw)))
    ws.on('close', () => {
      this.stopHeartbeat()
      if (this.ws !== ws) return // 已被新连接取代
      this.ws = null
      this.failPendingDispatch('连接已断开')
      if (!this.intentionalClose) this.scheduleReconnect('连接已断开')
    })
    ws.on('error', (e) => {
      // error 之后必然触发 close，重连交给 close 处理，这里只记录原因
      this.setStatus({ status: 'error', url: this.url, error: (e as Error).message })
    })
  }

  private scheduleReconnect(reason: string): void {
    if (this.intentionalClose || this.reconnectTimer) return
    this.reconnectAttempt++
    const delay = Math.min(RECONNECT_BASE_MS * 2 ** (this.reconnectAttempt - 1), RECONNECT_MAX_MS)
    this.setStatus({ status: 'error', url: this.url, error: reason })
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      if (!this.intentionalClose) this.open()
    }, delay)
  }

  private startHeartbeat(): void {
    this.stopHeartbeat()
    this.heartbeatTimer = setInterval(() => {
      if (!this.isConnected()) return
      this.send({ t: 'ping' })
      // 发出 ping 后启动宽限；若期间收到任何帧（含 pong）即清除
      this.graceTimer ??= setTimeout(() => {
        this.graceTimer = null
        this.ws?.terminate()
      }, HEARTBEAT_GRACE_MS)
    }, HEARTBEAT_MS)
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) { clearInterval(this.heartbeatTimer); this.heartbeatTimer = null }
    if (this.graceTimer) { clearTimeout(this.graceTimer); this.graceTimer = null }
  }

  /** 清理连接与定时器（不推送状态） */
  private teardown(): void {
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null }
    this.stopHeartbeat()
    const ws = this.ws
    this.ws = null
    if (ws) {
      ws.removeAllListeners()
      try { ws.terminate() } catch { /* 已关闭 */ }
    }
    this.failPendingDispatch('连接已重置')
  }

  dispose(): void {
    this.disconnect()
    this.tasks.clear()
    this.emit.tasks([])
  }

  // ------------------------------------------------------------------
  // 消息处理
  // ------------------------------------------------------------------

  private send(msg: ClientMsg): boolean {
    if (!this.isConnected()) return false
    try { this.ws!.send(JSON.stringify(msg)); return true } catch { return false }
  }

  private handleMessage(raw: string): void {
    // 收到任何帧即证明连接存活 — 清除心跳宽限
    if (this.graceTimer) { clearTimeout(this.graceTimer); this.graceTimer = null }

    let msg: HostMsg
    try { msg = JSON.parse(raw) as HostMsg } catch { return }
    if (!msg || typeof msg.t !== 'string') return

    switch (msg.t) {
      case 'hello':
        // 协议版本不匹配不阻断连接（字段只增不改），仅记录
        if (msg.version !== HOST_VERSION) {
          this.setStatus({ status: 'connected', url: this.url, error: `主机协议版本 v${msg.version}，客户端 v${HOST_VERSION}` })
        }
        break
      case 'pong':
        break
      case 'task.accepted':
        this.settleDispatch(msg.id, { ok: true, id: msg.id })
        this.upsertTask({ id: msg.id, patch: { status: 'queued' } })
        break
      case 'task.status':
        // awaiting_approval 是独立可见状态（UI 显示"等待审批"），原样保留
        this.upsertTask({ id: msg.id, patch: { status: msg.stage } })
        break
      case 'task.chunk':
        this.applyChunk(msg.id, msg.delta)
        break
      case 'task.done':
        this.upsertTask({ id: msg.id, patch: { status: msg.status, result: msg.result, error: msg.error, finishedAt: Date.now() } })
        break
      case 'error':
        // 幂等冲突等协议级错误 — 若在等待 dispatch 应答，直接结算
        if (msg.code === 'duplicate_id') this.failPendingDispatch(msg.message)
        break
      case 'approval.request':
        break // 以原始事件形式透传给渲染层，由 UI 弹确认框
    }

    // 原始事件整体透传 — 渲染层用于转录流式渲染
    this.emit.event(msg)
  }

  private applyChunk(id: string, delta: RunnerEvent): void {
    const existing = this.tasks.get(id)
    const rec: HostTaskRecord = existing ?? {
      id, task: '', status: 'running', chunks: [], result: '', createdAt: Date.now(),
    }
    rec.chunks.push(delta)
    // text 增量同时累积到 result，供列表行预览
    if (delta.type === 'text') rec.result += delta.text
    this.tasks.set(id, rec)
    this.emitTasks()
  }

  private upsertTask({ id, patch }: { id: string; patch: Partial<HostTaskRecord> }): void {
    const existing = this.tasks.get(id) ?? {
      id, task: '', status: 'queued' as const, chunks: [], result: '', createdAt: Date.now(),
    }
    this.tasks.set(id, { ...existing, ...patch })
    this.emitTasks()
  }

  private emitTasks(): void {
    this.emit.tasks([...this.tasks.values()])
  }

  private settleDispatch(id: string, result: { ok: boolean; id?: string; error?: string }): void {
    const p = this.pendingDispatch.get(id)
    if (!p) return
    clearTimeout(p.timer)
    this.pendingDispatch.delete(id)
    p.resolve(result)
  }

  private failPendingDispatch(error: string): void {
    for (const [id, p] of this.pendingDispatch) {
      clearTimeout(p.timer)
      p.resolve({ ok: false, error })
      this.pendingDispatch.delete(id)
    }
  }

  // ------------------------------------------------------------------
  // 控制面 API
  // ------------------------------------------------------------------

  /** 派任务 — 等待 task.accepted / error（幂等 id 由客户端生成便于关联） */
  dispatch(task: string, mode?: string): Promise<{ ok: boolean; id?: string; error?: string }> {
    if (!this.isConnected()) return Promise.resolve({ ok: false, error: '未连接到主机' })
    const id = `cabin_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pendingDispatch.delete(id)
        resolve({ ok: false, error: '主机未在 10s 内受理任务' })
      }, DISPATCH_TIMEOUT_MS)
      this.pendingDispatch.set(id, { resolve, timer })
      this.tasks.set(id, { id, task, status: 'queued', chunks: [], result: '', createdAt: Date.now() })
      this.emitTasks()
      if (!this.send({ t: 'task.dispatch', id, task, mode })) {
        this.settleDispatch(id, { ok: false, error: '发送失败' })
      }
    })
  }

  cancel(id: string): void {
    this.send({ t: 'task.cancel', id })
  }

  respondApproval(reqId: string, allow: boolean): void {
    this.send({ t: 'approval.respond', reqId, allow })
  }

  /** REST 查询历史任务并与本地实时视图合并 */
  async listTasks(): Promise<HostTaskRecord[]> {
    const data = await this.restGet<{ ok: boolean; tasks?: HostTaskRecord[] }>('/api/tasks')
    for (const rec of data?.tasks ?? []) {
      const live = this.tasks.get(rec.id)
      // 本地视图更新（有 chunks）时优先，否则用磁盘记录补齐历史
      if (!live || live.chunks.length === 0) this.tasks.set(rec.id, { ...rec, ...live, chunks: live?.chunks ?? rec.chunks })
    }
    this.emitTasks()
    return [...this.tasks.values()]
  }

  getTasks(): HostTaskRecord[] {
    return [...this.tasks.values()]
  }

  /** 健康检查 — 设置页「测试连接」用 */
  async health(): Promise<HostHealth> {
    if (!this.url || !this.token) return { ok: false, error: '未配置主机地址或令牌' }
    try {
      const data = await this.restGet<HostHealth>('/api/health')
      return data ?? { ok: false, error: '主机返回空响应' }
    } catch (e) {
      return { ok: false, error: (e as Error).message }
    }
  }

  private async restGet<T>(path: string): Promise<T | null> {
    const res = await fetch(restUrl(this.url, path), {
      headers: { Authorization: `Bearer ${this.token}` },
    })
    if (!res.ok) {
      throw new Error(res.status === 401 ? '令牌无效（401）' : `主机返回 ${res.status}`)
    }
    return (await res.json()) as T
  }
}

/** http(s)://host:port → ws(s)://host:port/ws；已带 /ws 则原样 */
export function wsUrl(base: string): string {
  const u = base.replace(/\/+$/, '')
  if (u.startsWith('ws://') || u.startsWith('wss://')) {
    return u.endsWith('/ws') ? u : `${u}/ws`
  }
  const scheme = u.startsWith('https://') ? 'wss' : 'ws'
  const rest = u.replace(/^https?:\/\//, '')
  return rest.endsWith('/ws') ? `${scheme}://${rest}` : `${scheme}://${rest}/ws`
}

/** http(s)://host:port + path；ws:// 输入一并归一化为 http */
export function restUrl(base: string, path: string): string {
  const u = base.replace(/\/+$/, '')
  const httpBase = u.startsWith('ws://') ? `http://${u.slice(5)}`
    : u.startsWith('wss://') ? `https://${u.slice(6)}`
    : u
  return `${httpBase}${path}`
}

/** 状态对外展示用地址 — 去掉可能残留的 query（令牌）*/
function safeUrlLabel(url: string): string {
  return url.split('?')[0]
}
