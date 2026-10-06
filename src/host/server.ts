/**
 * cockpit-link 服务端 — HTTP（健康/查询）+ WebSocket（控制/事件流）
 *
 * 安全：WS 与 REST 都要求令牌（WS 经 ?token= 或 Authorization 头）；
 * 审批语义 fail-closed：广播 approval.request 后等驾驶舱响应，
 * 超时（config.approvalTimeoutMs）一律视为拒绝。
 * 任务串行执行（runner v1 的 cwd/写白名单是进程级全局），排队任务可取消。
 */
import { createServer } from 'http'
import { randomBytes } from 'crypto'
import { readFileSync, readdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { WebSocketServer, WebSocket } from 'ws'
import { parseClientMsg, HOST_VERSION, HostMsg } from './protocol'
import { runTask } from './agent/task-runner'
import { DesktopBus } from './desktop/bus'
import { HostConfig, loadConfig, tasksDir, workspaceDir, ensureToken } from './config'
import type { HostTaskRecord, RunnerEvent } from '../shared/types/cockpit'

/** 任务记录 — 与驾驶舱共享的类型（REST /api/tasks 与 WS 增量描述同一实体） */
export type TaskRecord = HostTaskRecord

export interface HostDeps {
  /** 覆盖审批超时（测试用） */
  approvalTimeoutMs?: number
  /** 注入 desktop-bus（测试用 fake 后端）；缺省按 config.display 自建 */
  desktopBus?: DesktopBus
}

export interface HostServer {
  start: () => Promise<void>
  close: () => Promise<void>
  /** 供测试钩取状态 */
  _tasks: Map<string, { rec: TaskRecord; controller: AbortController }>
}

export function createHostServer(opts?: {
  config?: Partial<HostConfig>
  token?: string
  deps?: HostDeps
}): HostServer {
  const config = { ...loadConfig(), ...opts?.config }
  const approvalTimeoutMs = opts?.deps?.approvalTimeoutMs ?? config.approvalTimeoutMs
  const token = opts?.token ?? ensureToken().token

  const tasks = new Map<string, { rec: TaskRecord; controller: AbortController }>()
  const pendingApprovals = new Map<string, { resolve: (allow: boolean) => void; timer: NodeJS.Timeout }>()
  const conns = new Set<WebSocket>()
  let queue: Promise<void> = Promise.resolve()

  // desktop-bus — 桌面 API 总线（阶段 2）；注入优先，否则按 config.display 自建
  const desktopBus = opts?.deps?.desktopBus ?? new DesktopBus({ display: config.display })
  desktopBus.onEvent((e) => broadcast({ t: 'desktop.event', kind: e.kind, data: e.data }))

  const broadcast = (msg: HostMsg): void => {
    const raw = JSON.stringify(msg)
    for (const ws of conns) if (ws.readyState === WebSocket.OPEN) ws.send(raw)
  }

  const persist = (rec: TaskRecord): void => {
    try { writeFileSync(join(tasksDir(), `${rec.id}.json`), JSON.stringify(rec, null, 2)) } catch { /* 磁盘失败不阻断 */ }
  }

  function requestApproval(taskId: string, tool: string, summary: string): Promise<boolean> {
    const reqId = `req_${randomBytes(6).toString('hex')}`
    return new Promise((resolvePromise) => {
      const entry = {
        resolve: (allow: boolean): void => {
          clearTimeout(entry.timer)
          pendingApprovals.delete(reqId)
          const t = tasks.get(taskId)
          if (t && t.rec.status === 'running') broadcast({ t: 'task.status', id: taskId, stage: 'running' })
          resolvePromise(allow)
        },
        timer: null as unknown as NodeJS.Timeout,
      }
      entry.timer = setTimeout(() => entry.resolve(false), approvalTimeoutMs)
      pendingApprovals.set(reqId, entry)
      const t = tasks.get(taskId)
      if (t && t.rec.status === 'running') broadcast({ t: 'task.status', id: taskId, stage: 'awaiting_approval' })
      broadcast({ t: 'approval.request', reqId, id: taskId, tool, summary })
    })
  }

  /** 注册任务（立即返回，可取消排队中的任务） */
  function register(id: string, task: string, mode?: string): { rec: TaskRecord; controller: AbortController } {
    const controller = new AbortController()
    const rec: TaskRecord = { id, task, status: 'queued', chunks: [], result: '', createdAt: Date.now() }
    tasks.set(id, { rec, controller })
    persist(rec)
    return { rec, controller }
  }

  /** 实际执行 — 经串行队列调用 */
  async function dispatchTask(id: string, task: string, mode: string | undefined): Promise<void> {
    const entry = tasks.get(id)
    if (!entry) return
    const { rec, controller } = entry
    if (controller.signal.aborted) {
      rec.status = 'cancelled'
      rec.finishedAt = Date.now()
      persist(rec)
      broadcast({ t: 'task.done', id, status: 'cancelled', result: '' })
      return
    }

    rec.status = 'running'
    persist(rec)
    broadcast({ t: 'task.status', id, stage: 'running' })

    let seq = 0
    const onEvent = (e: RunnerEvent): void => {
      rec.chunks.push(e)
      broadcast({ t: 'task.chunk', id, seq: seq++, delta: e })
      persist(rec)
    }

    try {
      const out = await runTask({
        id, task,
        mode: mode || config.mode,
        workspace: workspaceDir(id),
        baseUrl: config.baseUrl,
        apiKey: config.apiKey,
        model: config.model,
        desktopBus,
        signal: controller.signal,
        onEvent,
        approval: (tool, summary) => requestApproval(id, tool, summary),
      })
      rec.status = out.status
      rec.result = out.result
      rec.error = out.error
      rec.finishedAt = Date.now()
      persist(rec)
      broadcast({ t: 'task.done', id, status: out.status, result: out.result, error: out.error })
    } catch (e) {
      rec.status = 'failed'
      rec.error = (e as Error).message.slice(0, 300)
      rec.finishedAt = Date.now()
      persist(rec)
      broadcast({ t: 'task.done', id, status: 'failed', result: '', error: rec.error })
    }
  }

  const httpServer = createServer((req, res) => {
    const authed = req.headers.authorization === `Bearer ${token}`
    const json = (code: number, body: unknown): void => {
      res.writeHead(code, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(body))
    }
    if (req.url === '/api/health') {
      if (!authed) return json(401, { ok: false, error: '需要 Bearer 令牌' })
      return json(200, { ok: true, name: 'ximo-host', version: HOST_VERSION, mode: config.mode })
    }
    if (req.url === '/api/tasks') {
      if (!authed) return json(401, { ok: false, error: '需要 Bearer 令牌' })
      const live = [...tasks.values()].map(({ rec }) => rec)
      const onDisk = readdirSync(tasksDir()).filter(f => f.endsWith('.json') && !live.some(r => recFileId(f) === r.id))
      const past = onDisk.slice(-50).map(f => {
        try { return JSON.parse(readFileSync(join(tasksDir(), f), 'utf-8')) as TaskRecord } catch { return null }
      }).filter(Boolean)
      return json(200, { ok: true, tasks: [...live, ...past] })
    }
    json(404, { ok: false, error: 'not found' })
  })

  const wss = new WebSocketServer({ noServer: true })

  httpServer.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    if (url.pathname !== '/ws') { socket.destroy(); return }
    const provided = url.searchParams.get('token') ?? (req.headers.authorization ?? '').replace(/^Bearer\s+/, '')
    if (!token || provided !== token) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n')
      socket.destroy()
      return
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      conns.add(ws)
      ws.send(JSON.stringify({ t: 'hello', version: HOST_VERSION, name: 'ximo-host' }))
      ws.on('message', (raw) => {
        const msg = parseClientMsg(String(raw))
        if (!msg) {
          ws.send(JSON.stringify({ t: 'error', code: 'bad_message', message: '无法解析的消息' }))
          ws.close()
          return
        }
        if (msg.t === 'ping') ws.send(JSON.stringify({ t: 'pong' }))
        else if (msg.t === 'task.dispatch') {
          if (tasks.has(msg.id ?? '')) {
            ws.send(JSON.stringify({ t: 'error', code: 'duplicate_id', message: `任务已存在: ${msg.id}` }))
            return
          }
          const id = msg.id || `task_${Date.now()}_${randomBytes(3).toString('hex')}`
          register(id, msg.task, msg.mode)
          broadcast({ t: 'task.accepted', id })
          queue = queue.then(() => dispatchTask(id, msg.task, msg.mode)).catch(() => {})
        } else if (msg.t === 'task.cancel') {
          tasks.get(msg.id)?.controller.abort()
        } else if (msg.t === 'approval.respond') {
          pendingApprovals.get(msg.reqId)?.resolve(msg.allow)
        } else if (msg.t === 'desktop.request') {
          // desktop-bus — 应答与事件均走本连接/广播（阶段 2）
          void desktopBus.dispatch(msg.action, msg.params ?? {})
            .then((data) => ws.send(JSON.stringify({ t: 'desktop.reply', reqId: msg.reqId, ok: true, data })))
            .catch((e: unknown) => ws.send(JSON.stringify({ t: 'desktop.reply', reqId: msg.reqId, ok: false, error: (e as Error).message.slice(0, 300) })))
        }
      })
      ws.on('close', () => conns.delete(ws))
      ws.on('error', () => conns.delete(ws))
    })
  })

  const recFileId = (f: string): string => f.replace(/\.json$/, '')

  return {
    _tasks: tasks,
    start: () => new Promise((resolvePromise) => {
      const [host, port] = config.listen.split(':')
      httpServer.listen(Number(port), host, () => resolvePromise())
    }),
    close: () => new Promise((resolvePromise) => {
      for (const { controller } of tasks.values()) if (!controller.signal.aborted) controller.abort()
      for (const ws of conns) ws.close()
      wss.close()
      httpServer.close(() => resolvePromise())
    }),
  }
}
