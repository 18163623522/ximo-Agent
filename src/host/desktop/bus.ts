/**
 * DesktopBus — ximo-OS 桌面 API 总线（阶段 2 内核，headless-first）
 *
 * 桌面本体是 API 总线：窗口树 / 应用 / 键盘输入都是结构化 JSON，
 * 驾驶舱 UI 与主机侧 Agent 是同等地位的客户端 —— 「纯 API 零截图」的地基。
 *
 * 错误语义：X 工具缺失 / 会话不可用 → 抛带归因的 Error，由调用方
 * （server → desktop.reply 或 Agent 工具）转成 ok:false。
 */
import type { DesktopAction, DesktopWindow } from '../../shared/types/cockpit'
import { CMD, makeLauncher, makeRunner, parseWmctrl, pidComm, type RunFn } from './backend'

export interface DesktopBusDeps {
  /** X 显示（Xvfb 会话）；空串 = 桌面功能停用 */
  display: string
  run?: RunFn
  launch?: (app: string, args: string[]) => { pid?: number }
  appName?: (pid: number) => string
}

export const WINDOW_OPS = ['activate', 'close', 'move', 'resize', 'minimize', 'maximize', 'restore'] as const
export type WindowOp = typeof WINDOW_OPS[number]

type Listener = (e: { kind: 'window' | 'app'; data: unknown }) => void

const EVENT_POLL_MS = 2000

export class DesktopBus {
  private readonly run: RunFn
  private readonly launchFn: (app: string, args: string[]) => { pid?: number }
  private readonly appName: (pid: number) => string
  private listeners = new Set<Listener>()
  private pollTimer: ReturnType<typeof setInterval> | null = null
  private lastWindowSet = ''
  /** 惰性归因 — 首次失败后记住 X 不可用，后续调用直接快速失败 */
  private unavailableReason: string | null = null

  constructor(private readonly deps: DesktopBusDeps) {
    this.run = deps.run ?? makeRunner(deps.display)
    this.launchFn = deps.launch ?? makeLauncher(deps.display)
    this.appName = deps.appName ?? pidComm
  }

  get enabled(): boolean {
    return this.deps.display !== ''
  }

  // ------------------------------------------------------------------
  // 事件推送 — 有订阅者才轮询；窗口集合变化即推完整快照
  // ------------------------------------------------------------------

  onEvent(fn: Listener): () => void {
    this.listeners.add(fn)
    if (this.pollTimer === null) {
      this.pollTimer = setInterval(() => { void this.checkEvents() }, EVENT_POLL_MS)
    }
    return () => {
      this.listeners.delete(fn)
      if (this.listeners.size === 0 && this.pollTimer !== null) {
        clearInterval(this.pollTimer)
        this.pollTimer = null
      }
    }
  }

  /** 轮询一步 — 对比窗口集合，变化即推事件（公开供测试驱动） */
  async checkEvents(): Promise<void> {
    if (this.listeners.size === 0) return
    try {
      const windows = await this.listWindows()
      const sig = windows.map((w) => `${w.id}:${w.title}:${w.x},${w.y},${w.w},${w.h}`).sort().join('|')
      if (sig !== this.lastWindowSet) {
        const changed = this.lastWindowSet !== ''
        this.lastWindowSet = sig
        if (changed) this.emit('window', windows)
      }
    } catch { /* 会话瞬断 — 下轮再试，不打断订阅 */ }
  }

  private emit(kind: 'window' | 'app', data: unknown): void {
    for (const fn of this.listeners) {
      try { fn({ kind, data }) } catch { /* 单个订阅者异常不影响其他 */ }
    }
  }

  // ------------------------------------------------------------------
  // dispatch — 总线路由
  // ------------------------------------------------------------------

  async dispatch(action: DesktopAction, params: Record<string, unknown> = {}): Promise<unknown> {
    if (!this.enabled) throw new Error('桌面功能未启用（config.display 为空）')
    switch (action) {
      case 'window.list':
        return this.listWindows()
      case 'window.op':
        return this.windowOp(params)
      case 'app.launch':
        return this.launchApp(String(params.app ?? ''), params.args)
      case 'app.list':
        return this.listApps()
      case 'key':
        return this.runCmd(CMD.key(this.require(params, 'keys')))
      case 'type':
        return this.runCmd(CMD.type(this.require(params, 'text')))
      case 'active': {
        const id = (await this.runCmd(CMD.activeId())).trim()
        if (!id) return null
        const windows = await this.listWindows()
        return windows.find((w) => w.id === id) ?? null
      }
      default:
        throw new Error(`未知的桌面操作: ${String(action)}`)
    }
  }

  // ------------------------------------------------------------------
  // 服务实现
  // ------------------------------------------------------------------

  /** 结构化窗口树 — 应用名由 /proc/<pid>/comm 补齐 */
  async listWindows(): Promise<DesktopWindow[]> {
    const { cmd, args } = CMD.listWindows()
    const raw = await this.runCmd({ cmd, args })
    return parseWmctrl(raw).map((w) => ({ ...w, app: w.pid > 0 ? this.appName(w.pid) : '' }))
  }

  /** 运行中的应用 — 按进程聚合窗口 */
  async listApps(): Promise<{ app: string; pid: number; windows: DesktopWindow[] }[]> {
    const windows = await this.listWindows()
    const byPid = new Map<number, DesktopWindow[]>()
    for (const w of windows) {
      const list = byPid.get(w.pid) ?? []
      list.push(w)
      byPid.set(w.pid, list)
    }
    return [...byPid.entries()].map(([pid, ws]) => ({
      pid,
      app: ws[0]?.app || `pid:${pid}`,
      windows: ws,
    }))
  }

  async launchApp(app: string, args?: unknown): Promise<{ pid?: number }> {
    if (!app.trim()) throw new Error('app.launch 需要 app 参数')
    const argList = Array.isArray(args) ? args.map(String) : []
    const { pid } = this.launchFn(app.trim(), argList)
    return pid ? { pid } : {}
  }

  private async windowOp(params: Record<string, unknown>): Promise<{ done: boolean }> {
    const op = String(params.op ?? '')
    if (!WINDOW_OPS.includes(op as WindowOp)) {
      throw new Error(`window.op 需要 op ∈ ${WINDOW_OPS.join('/')}`)
    }
    const id = await this.resolveWindowId(params)
    const cmd =
      op === 'activate' ? CMD.activate(id)
      : op === 'close' ? CMD.close(id)
      : op === 'minimize' ? CMD.minimize(id)
      : op === 'maximize' ? CMD.maximize(id)
      : op === 'restore' ? CMD.restore(id)
      : CMD.moveResize(
          id,
          Number(params.x ?? -1), Number(params.y ?? -1),
          Number(params.w ?? -1), Number(params.h ?? -1),
        )
    await this.runCmd(cmd)
    return { done: true }
  }

  /** 定位窗口 — window_id 优先，否则按标题子串查找 */
  private async resolveWindowId(params: Record<string, unknown>): Promise<string> {
    const id = String(params.window_id ?? '')
    if (id) return id
    const title = String(params.title ?? '')
    if (!title) throw new Error('window.op 需要 window_id 或 title 参数')
    const windows = await this.listWindows()
    const hit = windows.find((w) => w.title.includes(title))
    if (!hit) throw new Error(`未找到标题包含「${title}」的窗口`)
    return hit.id
  }

  // ------------------------------------------------------------------
  // 执行与错误归因
  // ------------------------------------------------------------------

  private require(params: Record<string, unknown>, key: string): string {
    const v = String(params[key] ?? '')
    if (!v) throw new Error(`${key} 参数必填`)
    return v
  }

  private async runCmd({ cmd, args }: { cmd: string; args: string[] }): Promise<string> {
    try {
      const out = await this.run(cmd, args)
      this.unavailableReason = null
      return out
    } catch (e) {
      // 统一归因 — ENOENT = X 工具缺失；其余视为会话不可用
      const msg = (e as Error).message ?? String(e)
      if (msg.includes('ENOENT')) {
        this.unavailableReason = `X 工具未安装（需要 xdotool/wmctrl）：${cmd}`
      } else if (!this.unavailableReason) {
        this.unavailableReason = `桌面会话不可用（DISPLAY=${this.deps.display}）：${msg.slice(0, 200)}`
      }
      throw new Error(this.unavailableReason)
    }
  }
}
