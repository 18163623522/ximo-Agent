/**
 * task-worker — 任务执行子进程入口（阶段 D2 并发隔离）
 *
 * 为什么子进程：chdir 与写白名单是进程级全局 —— 每任务 fork 一个子进程，
 * 任务间的工作区/路径语义/写白名单互不可见（原单进程串行模型的并发化改造）。
 *
 * IPC 协议（parent ↔ worker，Node fork 的 message 通道）：
 *   parent → worker : { t:'input', input }                任务输入（纯 JSON）
 *   parent → worker : { t:'cancel' }                      取消（级联 abort）
 *   parent → worker : { t:'approval-resp', reqId, allow } 审批应答
 *   parent → worker : { t:'desktop-reply', reqId, ok, data?, error? } 桌面 RPC 应答
 *   worker → parent : { t:'event', event: RunnerEvent }   任务事件流
 *   worker → parent : { t:'approval', reqId, tool, summary } 请求审批（父广播+超时）
 *   worker → parent : { t:'desktop', reqId, action, params }  桌面总线 RPC（共享父的总线）
 *   worker → parent : { t:'result', output: TaskOutput }  终态
 *
 * 桌面总线经父进程代理：worker 不自建 DesktopBus —— 父进程的单例总线维持
 * cockpit 的 desktop.event 推送与画面采集，worker 侧只是一个 RPC 客户端。
 */
import { runTask } from './task-runner'
import type { TaskInput, TaskOutput } from './task-runner'
import type { DesktopBus } from '../desktop/bus'
import type { DesktopAction, RunnerEvent } from '../../shared/types/cockpit'

/** 桌面总线 RPC 客户端 — 结构上兼容 DesktopBusTool 所需的 dispatch/enabled 面。
 *  导出供单测直接驱动（本项目真机踩过「handler 未接线 → RPC 静默超时」的坑）。 */
export class ProxyDesktopBus {
  readonly enabled = true
  private readonly pending = new Map<string, (v: { ok: boolean; data?: unknown; error?: string }) => void>()

  constructor(private readonly send: (m: unknown) => void) {}

  handleReply(m: { reqId: string; ok: boolean; data?: unknown; error?: string }): void {
    const resolve = this.pending.get(m.reqId)
    if (!resolve) return
    this.pending.delete(m.reqId)
    resolve({ ok: m.ok, data: m.data, error: m.error })
  }

  get pendingCount(): number { return this.pending.size }

  async dispatch(action: DesktopAction, params: Record<string, unknown> = {}): Promise<unknown> {
    const reqId = `wd_${Math.random().toString(36).slice(2, 10)}`
    return new Promise((resolve, reject) => {
      this.pending.set(reqId, (r) => (r.ok ? resolve(r.data) : reject(new Error(r.error ?? '桌面调用失败'))))
      this.send({ t: 'desktop', reqId, action, params })
      // 兜底超时 — 父进程消失时不至于永久挂起
      setTimeout(() => {
        if (this.pending.has(reqId)) {
          this.pending.delete(reqId)
          reject(new Error('桌面总线 RPC 超时（父进程无应答）'))
        }
      }, 30_000)
    })
  }
}

/** worker 侧消息处理器 — runWorkerTask 与父进程的桥 */
interface WorkerHandler {
  onMessage: (m: {
    t: string
    reqId?: string
    allow?: boolean
    ok?: boolean
    data?: unknown
    error?: string
  }) => void
}

/** worker 主体 — 供测试直接驱动（不依赖 fork 环境）。
 *  input 为纯 JSON（不含 onEvent/signal/approval/desktopBus，由本函数重建）。 */
export async function runWorkerTask(
  input: {
    id: string
    task: string
    mode: string
    workspace: string
    baseUrl: string
    apiKey: string
    model: string
    desktopBusEnabled?: boolean
  },
  send: (m: unknown) => void,
  registerHandler?: (h: WorkerHandler) => void,
): Promise<void> {
  const abort = new AbortController()
  process.once('SIGTERM', () => abort.abort())
  process.once('SIGINT', () => abort.abort())

  const bus = new ProxyDesktopBus(send)
  const approvals = new Map<string, (allow: boolean) => void>()

  registerHandler?.({
    onMessage: (m) => {
      if (m.t === 'cancel') abort.abort()
      else if (m.t === 'approval-resp' && m.reqId) approvals.get(m.reqId)?.(m.allow === true)
      else if (m.t === 'desktop-reply' && m.reqId) bus.handleReply({ reqId: m.reqId, ok: m.ok === true, data: m.data, error: m.error })
    },
  })

  const taskInput: TaskInput = {
    id: input.id,
    task: input.task,
    mode: input.mode,
    workspace: input.workspace,
    baseUrl: input.baseUrl,
    apiKey: input.apiKey,
    model: input.model,
    desktopBus: (input.desktopBusEnabled ? (bus as unknown as DesktopBus) : undefined),
    signal: abort.signal,
    onEvent: (e: RunnerEvent) => send({ t: 'event', event: e }),
    approval: (tool, summary) =>
      new Promise<boolean>((resolve) => {
        const reqId = `wa_${Math.random().toString(36).slice(2, 10)}`
        const timer = setTimeout(() => {
          // fail-closed 兜底：父进程 150s 内不回就拒绝（父侧另有 120s 超时广播）
          if (approvals.has(reqId)) resolve(false)
        }, 150_000)
        approvals.set(reqId, (allow) => {
          clearTimeout(timer)
          approvals.delete(reqId)
          resolve(allow)
        })
        send({ t: 'approval', reqId, tool, summary })
      }),
  }

  const output: TaskOutput = await runTask(taskInput)
  send({ t: 'result', output })
}

/** fork 入口 — 父进程以 XIMO_TASK_WORKER=1 环境变量拉起时激活 */
export function workerMain(): void {
  if (process.env.XIMO_TASK_WORKER !== '1' || !process.send) return
  const send = (m: unknown): void => { try { process.send!(m) } catch { /* 通道已关 */ } }
  process.on('message', (m: { t?: string; input?: Parameters<typeof runWorkerTask>[0] }) => {
    if (m?.t === 'input' && m.input) {
      const input = m.input
      // ⚠ 必须把 process 消息转交 runWorkerTask 的处理器：漏传会让 desktop-reply /
      // approval-resp 全部丢弃 → 桌面 RPC 30s 超时、审批永远走 150s fail-closed 兜底
      void runWorkerTask(input, send, (h) => {
        process.on('message', (msg: Parameters<typeof h.onMessage>[0]) => h.onMessage(msg))
      }).catch((e: unknown) => {
        send({ t: 'result', output: { status: 'failed', result: '', error: (e as Error).message.slice(0, 300) } })
        process.exit(1)
      })
    }
  })
  send({ t: 'ready' })
}

workerMain()
