/**
 * DesktopBus — ximo-OS 桌面 API 总线（阶段 2 内核，headless-first）
 *
 * 桌面本体是 API 总线：窗口树 / 应用 / 键盘输入都是结构化 JSON，
 * 驾驶舱 UI 与主机侧 Agent 是同等地位的客户端 —— 「纯 API 零截图」的地基。
 *
 * 错误语义：X 工具缺失 / 会话不可用 → 抛带归因的 Error，由调用方
 * （server → desktop.reply 或 Agent 工具）转成 ok:false。
 */
import type { DesktopAction, DesktopAppEntry, DesktopScreenSize, DesktopWindow } from '../../shared/types/cockpit'
import { CMD, makeLauncher, makeRunner, mouseButtonCode, normalizeWindowId, parseDesktopEntry, parseWmctrl, pidComm, scrollButtonCode, type RunFn } from './backend'

export interface DesktopBusDeps {
  /** X 显示（Xvfb 会话）；空串 = 桌面功能停用 */
  display: string
  run?: RunFn
  launch?: (app: string, args: string[]) => { pid?: number }
  appName?: (pid: number) => string
  /** 截图兜底 — screen.snapshot 动作的数据源（server 侧注入 ScreenCapture） */
  snapshot?: () => Promise<{ dataUrl: string; savedPath?: string } | null>
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
      case 'app.available':
        return this.availableApps()
      case 'key':
        return this.runCmd(CMD.key(this.require(params, 'keys')))
      case 'type':
        return this.runCmd(CMD.type(this.require(params, 'text')))
      case 'active': {
        // xdotool getactivewindow 输出**十进制**，而 wmctrl 输出十六进制（0x…）
        // → 必须先归一化为十六进制再比对，否则永远匹配不到（历史 bug）
        // getactivewindow 无聚焦窗口时返回 rc=1 — 正常空态，不归因为会话不可用
        let raw: string
        try {
          raw = (await this.runCmd(CMD.activeId())).trim()
        } catch {
          // rc=1 正常空态（无聚焦窗口）
          return null
        }
        const id = normalizeWindowId(raw)
        if (!id) return null
        const windows = await this.listWindows()
        return windows.find((w) => normalizeWindowId(w.id) === id) ?? null
      }
      case 'mouse.move':
        return this.runCmd(CMD.mouseMove(this.coord(params.x), this.coord(params.y)))
      case 'mouse.click': {
        const btn = mouseButtonCode(String(params.button ?? 'left'))
        return this.runCmd(CMD.mouseClick(this.coord(params.x), this.coord(params.y), btn))
      }
      case 'mouse.scroll': {
        const dir = String(params.direction ?? 'down')
        const amount = Math.max(1, Math.min(10, Number(params.amount ?? 3)))
        const btn = scrollButtonCode(dir)
        return this.runCmd(CMD.mouseScroll(this.coord(params.x ?? -1), this.coord(params.y ?? -1), amount, btn))
      }
      case 'screen.size': {
        // 输出形如 "1280 800"
        const out = (await this.runCmd(CMD.displayGeometry())).trim().split(/\s+/)
        const size: DesktopScreenSize = { width: Number(out[0]) || 0, height: Number(out[1]) || 0 }
        if (!size.width || !size.height) throw new Error('无法读取屏幕几何')
        return size
      }
      case 'clipboard.read': {
        // 读剪贴板 — 读取 GUI 应用内容的最快通路（比截图准且无需视觉模型）。
        // 注意：剪贴板为空时 xclip 以非 0 退出并报 "target STRING not available"，
        // 这是正常空态而非故障。runCmd 对非零退出码不置位 unavailableReason，
        // 所以这里可以直接用 runCmd — 一次空读不会导致后续操作快速失败。
        try {
          const { cmd, args } = CMD.clipboardRead()
          return { text: await this.runCmd({ cmd, args }) }
        } catch {
          // 正常空态（剪贴板无内容）
          return { text: '' }
        }
      }
      case 'clipboard.write': {
        const text = String(params.text ?? '')
        await this.runCmd(CMD.clipboardWrite(), text)
        return { done: true, length: text.length }
      }
      case 'screen.snapshot': {
        // 兜底感知 — 纯 API 不足以判断画面时（如确认 GUI 渲染结果）用
        if (!this.deps.snapshot) throw new Error('截图能力未启用（主机未配置画面采集）')
        const shot = await this.deps.snapshot()
        if (!shot) throw new Error('截图失败（桌面会话未就绪）')
        // savedPath 交回 Agent → 可直接喂给 vision_analyze(file_path=…)
        return { screenshot: shot.dataUrl, ...(shot.savedPath ? { savedPath: shot.savedPath } : {}) }
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

  /**
   * 可启动应用清单 — 扫 /usr/share/applications 的 .desktop 条目。
   * 让 Agent 不必猜应用名（猜错就是一次失败的 launch），这是纯 API 自动化的前提。
   */
  async availableApps(): Promise<DesktopAppEntry[]> {
    const dirs = ['/usr/share/applications', '/usr/local/share/applications']
    const entries: DesktopAppEntry[] = []
    const seen = new Set<string>()
    for (const dir of dirs) {
      let listing: string
      try {
        listing = await this.runCmd({ cmd: 'ls', args: [dir] })
      } catch { continue } // 目录不存在 → 跳过
      for (const file of listing.split('\n').map((f) => f.trim()).filter((f) => f.endsWith('.desktop'))) {
        try {
          const raw = await this.runCmd({ cmd: 'cat', args: [`${dir}/${file}`] })
          const entry = parseDesktopEntry(raw)
          if (!entry || seen.has(entry.exec)) continue
          seen.add(entry.exec)
          entries.push(entry)
        } catch { /* 单个条目读取失败不影响其余 */ }
      }
    }
    return entries.sort((a, b) => a.name.localeCompare(b.name))
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
    const raw = String(params.window_id ?? '')
    const windows = await this.listWindows()
    if (raw) {
      // 归一化后匹配 — 调用方可能给十进制（xdotool 风格）或十六进制（wmctrl 风格）
      const want = normalizeWindowId(raw)
      const hit = windows.find((w) => normalizeWindowId(w.id) === want)
      if (hit) return hit.id
      // 归一化失败（如传入非数字串）时退化为原样透传，保留扩展可能
      if (!want) return raw
      throw new Error(`未找到窗口 id ${raw}（当前 ${windows.length} 个窗口）`)
    }
    const title = String(params.title ?? '')
    if (!title) throw new Error('window.op 需要 window_id 或 title 参数')
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

  /** 坐标强转 — 非数字 / null / undefined 抛参数错误（不归零，避免误点击 (0,0)） */
  private coord(v: unknown): number {
    if (v === null || v === undefined || typeof v === 'boolean') {
      throw new Error(`坐标参数无效：期望数字，收到 ${JSON.stringify(v)}`)
    }
    const n = Number(v)
    if (!Number.isFinite(n)) {
      throw new Error(`坐标参数无效：期望数字，收到 ${JSON.stringify(v)}`)
    }
    return Math.round(n)
  }

  private async runCmd({ cmd, args }: { cmd: string; args: string[] }, stdin?: string): Promise<string> {
    try {
      const out = await this.run(cmd, args, undefined, stdin)
      this.unavailableReason = null // 成功即清缓存 — 会话恢复后自动自愈（事件轮询每 2s 重探）
      return out
    } catch (e) {
      // 错误形状必须与真实 execFile 一致：非零退出时 code 是**数字**退出码，
      // status 字段不存在（实测 Node v24）。模拟错误时不得虚构 status。
      const err = e as Error & { code?: string | number; killed?: boolean }
      const msg = err.message ?? String(e)
      // ENOENT = X 工具缺失 → 真故障，置位（安装工具后下一次成功调用自动恢复）
      if (err.code === 'ENOENT') {
        this.unavailableReason = `X 工具未安装（需要 xdotool/wmctrl）：${cmd}`
        throw new Error(this.unavailableReason)
      }
      // 非零退出码（数字 code）— 多为正常空态（getactivewindow 无聚焦、xclip 空读、
      // ls 目录不存在）→ 不置位，让调用方按返回值/异常各自处理
      if (typeof err.code === 'number' && err.code > 0) {
        throw new Error(`${cmd} 退出码 ${err.code}：${msg.slice(0, 200)}`)
      }
      // 其余（timeout 杀进程 / 信号终止 / 未知）→ 视为会话不可用，置位
      this.unavailableReason ??= `桌面会话不可用（DISPLAY=${this.deps.display}）：${msg.slice(0, 200)}`
      throw new Error(this.unavailableReason)
    }
  }
}
