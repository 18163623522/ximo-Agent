/**
 * AgentWorkspaceManager — WSL 隔离桌面系统
 *
 * 设计灵感：agent-workspace-linux
 * 在 WSL2 内运行 Xvfb + Openbox 构建 headless X11 桌面，
 * Agent 通过 xdotool 操作，通过 import 截屏。
 *
 * 自动引导流程（用户只需点"启动"，其余全部自动）：
 *   1. 检测 WSL 功能是否已启用 → 未启用则自动 dism /enable（UAC 提权）
 *   2. 检测是否有 Debian 发行版 → 没有则自动 wsl --install -d Debian
 *   3. 首次启动 Debian（设置 root 默认用户，跳过交互）
 *   4. 在 WSL 内安装 Xvfb/Openbox/xdotool 等依赖
 *   5. 启动 Xvfb + Openbox + xterm
 *   6. 开始截图轮询
 *
 * 唯一需要人工介入的：Windows 启用新功能后需要重启（一次性）。
 * 重启后用户再点"启动"即可全自动完成剩余步骤。
 */

import { DISPLAY, execWslDisplay, execWslRaw } from './wsl-exec'
import { WSL_INIT_SCRIPT, deployInitScript } from './init-script'
import { enableWslFeature, firstBootDistro, getLastInstallError, hasDistro, installDistro,
  isVmPlatformEnabled, isVirtualizationAvailable, isWslFeatureEnabled, isWslFunctional, switchToWsl1 } from './bootstrap'
import * as ops from './desktop-ops'

/** 引导阶段 — 用于 UI 显示进度 */
export type SetupStage =
  | 'idle'
  | 'checking_wsl'      // 检测 WSL 功能
  | 'enabling_wsl'      // 启用 WSL 功能（dism）
  | 'installing_distro'  // 安装 Linux 发行版
  | 'first_boot'        // 首次启动 Ubuntu
  | 'installing_deps'   // 安装 Xvfb 等依赖
  | 'starting_desktop'  // 启动 Xvfb + Openbox
  | 'ready'             // 就绪
  | 'needs_reboot'      // 需要重启
  | 'error'

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------

export interface WorkspaceState {
  running: boolean
  display: string
  installedApps: string[]
  lastScreenshot: string | null
  error: string | null
  /** ffmpeg 实时画面流是否就绪（false 时面板回退快照轮询模式） */
  streamAvailable: boolean
  /** 当前引导阶段 */
  setupStage: SetupStage
  /** 引导进度消息 */
  setupMessage: string
}

// ---------------------------------------------------------------------------
// AgentWorkspaceManager — 单例
// ---------------------------------------------------------------------------

class AgentWorkspaceManagerImpl {
  private state: WorkspaceState = {
    running: false,
    display: DISPLAY,
    installedApps: [],
    lastScreenshot: null,
    error: null,
    streamAvailable: false,
    setupStage: 'idle',
    setupMessage: '',
  }

  private wslReady = false
  private initScriptDeployed = false
  /** 进度回调 — 供 IPC 实时推送 */
  private progressCallback: ((stage: SetupStage, message: string) => void) | null = null

  /** 设置进度回调 */
  onProgress(cb: (stage: SetupStage, message: string) => void): void {
    this.progressCallback = cb
  }

  private setStage(stage: SetupStage, message: string): void {
    this.state.setupStage = stage
    this.state.setupMessage = message
    this.progressCallback?.(stage, message)
  }

  // -----------------------------------------------------------------------
  // 公开 API
  // -----------------------------------------------------------------------

  /**
   * 启动 Agent 工作区 — 全自动引导
   * 用户只需调用此方法，所有依赖检测和安装自动完成
   */
  async start(): Promise<WorkspaceState> {
    try {
      // === 阶段 1：检测 WSL 功能 ===
      this.setStage('checking_wsl', '正在检测 WSL 功能…')

      const wslFunctional = await isWslFunctional()

      if (!wslFunctional) {
        // WSL 功能未生效 — 检查是否已启用但需要重启
        const wslEnabled = await isWslFeatureEnabled()
        const vmEnabled = await isVmPlatformEnabled()

        if (!wslEnabled || !vmEnabled) {
          // 自动启用缺失的功能（enableWslFeature 内部会同时启用 WSL + VMP，并处理 UAC 提权）
          this.setStage('enabling_wsl', '正在启用 WSL 和虚拟机平台功能（可能弹出 UAC 确认）…')
          const ok = await enableWslFeature()
          if (!ok) {
            this.setStage('error', 'WSL 功能启用失败。请右键以管理员身份运行本应用，或手动运行 wsl --install。')
            this.state.error = 'WSL 功能启用失败（需要管理员权限）。'
            return { ...this.state }
          }

          // 检查是否现在可用了
          const nowFunctional = await isWslFunctional()
          if (!nowFunctional) {
            this.setStage('needs_reboot', 'WSL 功能已启用，需要重启电脑才能生效。重启后再次点击启动即可。')
            this.state.error = '需要重启电脑完成 WSL 安装。重启后再次点击启动按钮。'
            return { ...this.state }
          }
        } else {
          // 功能已启用但未生效 → 需要重启
          this.setStage('needs_reboot', 'WSL 功能已启用但需要重启电脑才能生效。')
          this.state.error = '需要重启电脑完成 WSL 安装。重启后再次点击启动按钮。'
          return { ...this.state }
        }
      }

      // === 阶段 2：虚拟化预检（不可用时自动降级 WSL1）+ 检测 Debian 发行版 ===
      if (!(await isVirtualizationAvailable())) {
        this.setStage('checking_wsl', '未检测到 CPU 虚拟化 — 自动切换 WSL1 模式（无需 VT-x，性能稍低）…')
        const switched = await switchToWsl1()
        if (!switched) {
          const hint = 'WSL1 切换失败 — 请重启进入 BIOS 开启 VT-x/AMD-V（或 SVM 模式）后使用 WSL2，或手动运行 wsl --set-default-version 1'
          this.setStage('error', hint)
          this.state.error = hint
          return { ...this.state }
        }
      }

      this.setStage('checking_wsl', '正在检测 Debian 发行版…')
      const hasDistroInstalled = await hasDistro()

      if (!hasDistroInstalled) {
        // 自动安装 Debian
        this.setStage('installing_distro', '正在下载并安装 Debian（约 300MB，首次可能需要几分钟；若弹出 UAC 确认窗口请点「是」）…')
        const installed = await installDistro()
        if (!installed) {
          const lastErr = getLastInstallError()
          const reason = lastErr ? `：${lastErr}` : ''
          this.setStage('error', `Debian 安装失败${reason}。可手动运行 wsl --install -d Debian 后重试`)
          this.state.error = `Debian 发行版安装失败${reason}。`
          return { ...this.state }
        }
      }

      // === 阶段 3：首次启动 Debian ===
      this.setStage('first_boot', '正在初始化 Debian…')
      // 检查是否需要首次初始化
      try {
        await execWslRaw('echo OK', 15_000)
      } catch {
        // 首次启动需要初始化
        const booted = await firstBootDistro()
        if (!booted) {
          this.setStage('error', 'Debian 首次启动失败')
          this.state.error = 'Debian 首次启动失败。'
          return { ...this.state }
        }
      }

      // === 阶段 4：安装桌面依赖 ===
      this.setStage('installing_deps', '正在安装 Xvfb/Openbox/xdotool 等依赖（首次可能需要 1-2 分钟）…')
      if (!this.initScriptDeployed) {
        await deployInitScript()
        this.initScriptDeployed = true
      }

      // === 阶段 5：启动桌面 ===
      this.setStage('starting_desktop', '正在启动 Xvfb 虚拟显示 + Openbox 窗口管理器…')
      const output = await execWslRaw(`bash ${WSL_INIT_SCRIPT}`, 180_000)

      if (!output.includes('OK:')) {
        throw new Error(`桌面启动失败: ${output.slice(0, 500)}`)
      }

      // === 阶段 6：就绪 ===
      this.wslReady = true
      this.state.running = true
      this.state.error = null
      this.lastAlive = true
      this.lastAliveAt = Date.now()
      this.setStage('ready', 'Agent 桌面已就绪')

      // 获取应用列表
      try {
        const apps = await execWslDisplay('ls /usr/bin/ 2>/dev/null | head -50')
        this.state.installedApps = apps.trim().split('\n').filter(Boolean)
      } catch {
        this.state.installedApps = []
      }

      // 探测 ffmpeg 实时画面流是否就绪（失败则面板回退快照轮询模式）
      this.state.streamAvailable = await ops.waitForStream()

      return { ...this.state }
    } catch (e) {
      this.setStage('error', `启动失败: ${(e as Error).message}`)
      this.state.error = `启动工作区失败: ${(e as Error).message}`
      return { ...this.state }
    }
  }

  /** 停止 Agent 工作区 */
  async stop(): Promise<WorkspaceState> {
    if (this.wslReady) {
      try {
        await execWslRaw('pkill -f "Xvfb :99" 2>/dev/null; pkill openbox 2>/dev/null; pkill ffmpeg 2>/dev/null; true')
      } catch { /* 忽略 */ }
    }

    this.wslReady = false
    this.state.running = false
    this.state.streamAvailable = false
    this.state.lastScreenshot = null
    this.lastAlive = false
    this.lastAliveAt = 0
    this.setStage('idle', '')
    return { ...this.state }
  }

  /** 获取当前状态 */
  getState(): WorkspaceState {
    return { ...this.state }
  }

  /** 截图（含留存元数据）— dataUrl 供 UI 展示，savedPath 是 Windows 侧留存路径（vision_analyze 用） */
  async screenshotWithMeta(): Promise<{ dataUrl: string; savedPath?: string } | null> {
    if (!this.wslReady) return null
    const shot = await ops.screenshot()
    if (shot) this.state.lastScreenshot = shot.dataUrl
    return shot
  }

  /** 截图 — 返回 base64 data URL（成功时写入状态缓存 lastScreenshot） */
  async screenshot(): Promise<string | null> {
    return (await this.screenshotWithMeta())?.dataUrl ?? null
  }

  private ensureStreamPromise: Promise<void> | null = null

  /** 确保画面流 ffmpeg 存活 — 由 wslcam:// 协议 handler 在每次渲染层请求时调用。
   *  http listen 是单次会话：客户端断开后 ffmpeg 进程退出，下次请求时在此重新拉起。
   *  存活检查用 pgrep -x（按进程名），见 waitForStream 注释。 */
  async ensureStreamRunning(): Promise<void> {
    if (!this.wslReady) return
    this.ensureStreamPromise ??= ops.doEnsureStream().finally(() => { this.ensureStreamPromise = null })
    await this.ensureStreamPromise
  }

  /** 鼠标点击 */
  async click(x: number, y: number, button: 'left' | 'right' | 'middle' = 'left'): Promise<boolean> {
    if (!this.wslReady) return false
    return ops.click(x, y, button)
  }

  /** 双击 */
  async doubleClick(x: number, y: number): Promise<boolean> {
    if (!this.wslReady) return false
    return ops.doubleClick(x, y)
  }

  /** 鼠标移动 */
  async mouseMove(x: number, y: number): Promise<boolean> {
    if (!this.wslReady) return false
    return ops.mouseMove(x, y)
  }

  /** 按键 */
  async keyPress(keys: string): Promise<boolean> {
    if (!this.wslReady) return false
    return ops.keyPress(keys)
  }

  /** 输入文本 */
  async typeText(text: string): Promise<boolean> {
    if (!this.wslReady) return false
    return ops.typeText(text)
  }

  /** 在 WSL 内执行命令 — timeoutSec 可放宽（上限 600s）；stdin 单向喂入命令（非 TTY） */
  async exec(command: string, timeoutSec = 30, stdin?: string): Promise<{ success: boolean; output: string; error: string }> {
    if (!this.wslReady) return { success: false, output: '', error: '工作区未启动' }
    return ops.exec(command, timeoutSec, stdin)
  }

  /** 启动应用（可带参数，如 URL/文件路径）— setsid + 三流重定向完全脱离会话，防 GUI 应用占用管道导致调用挂起。
   *  返回 alive 表示启动后 ~3s 内探测到同名进程；进程名与启动名不同（.desktop 包装）时不据此判死 */
  async launchApp(appName: string, args?: string): Promise<{ success: boolean; alive: boolean; error?: string }> {
    if (!this.wslReady) return { success: false, alive: false, error: '工作区未启动' }
    return ops.launchApp(appName, args)
  }

  /** 滚轮滚动 — xdotool 虚拟按键 4/5（纵向）6/7（横向） */
  async scroll(direction: 'up' | 'down' | 'left' | 'right', amount = 3): Promise<boolean> {
    if (!this.wslReady) return false
    return ops.scroll(direction, amount)
  }

  /** 拖拽 — 按下左键移动到终点后松开（--sync 确保路径逐点完成） */
  async drag(x1: number, y1: number, x2: number, y2: number): Promise<boolean> {
    if (!this.wslReady) return false
    return ops.drag(x1, y1, x2, y2)
  }

  /** 按下/松开按键 — 与 click 组合实现「按住修饰键再点击」等手势（用完必须 key_up） */
  async keyDown(keys: string): Promise<boolean> {
    if (!this.wslReady) return false
    return ops.keyDown(keys)
  }

  async keyUp(keys: string): Promise<boolean> {
    if (!this.wslReady) return false
    return ops.keyUp(keys)
  }

  /** 读取桌面剪贴板内容（与 paste 动作构成双向通道） */
  async clipboardRead(): Promise<string | null> {
    if (!this.wslReady) return null
    return ops.clipboardRead()
  }

  /** 窗口管理 — 按 id（window_list 取得）或标题子串定位，经 wmctrl 操作 */
  async windowOp(
    op: 'activate' | 'close' | 'move' | 'resize' | 'minimize' | 'maximize' | 'restore',
    target: { windowId?: string; title?: string },
    geo?: { x?: number; y?: number; w?: number; h?: number }
  ): Promise<{ success: boolean; error?: string }> {
    if (!this.wslReady) return { success: false, error: '工作区未启动' }
    return ops.windowOp(op, target, geo)
  }

  /** 修改桌面分辨率 — 写入配置后重跑 init 脚本重启 Xvfb/WM/面板/画面流（会关闭当前所有窗口） */
  async setResolution(width: number, height: number): Promise<{ success: boolean; error?: string }> {
    if (!this.wslReady) return { success: false, error: '工作区未启动' }
    return ops.setResolution(width, height)
  }

  // -----------------------------------------------------------------------
  // 存活探测与自愈 — 消除 wslReady 与桌面真实状态的漂移
  // -----------------------------------------------------------------------

  private lastAliveAt = 0
  private lastAlive = false

  /** 探测 Xvfb 存活（5s 结果缓存）；会话假死时重跑 init 脚本自愈一次 */
  async ensureAlive(): Promise<boolean> {
    if (!this.wslReady) return false
    const now = Date.now()
    if (now - this.lastAliveAt < 5_000) return this.lastAlive
    this.lastAliveAt = now
    try {
      const out = await execWslRaw('pgrep -x Xvfb >/dev/null 2>&1 && echo ALIVE || echo DEAD', 10_000)
      this.lastAlive = out.includes('ALIVE')
    } catch {
      this.lastAlive = false
    }
    if (!this.lastAlive) {
      try {
        await execWslRaw(`bash ${WSL_INIT_SCRIPT}`, 180_000)
        this.lastAlive = true
        this.lastAliveAt = Date.now()
      } catch {
        this.lastAlive = false
      }
    }
    return this.lastAlive
  }

  /** 粘贴文本（经剪贴板）— CJK 直输在部分应用（浏览器）受限，剪贴板粘贴是可靠通道。
   *  xclip 必须在同一次 exec 内存活到 ctrl+v 完成（它持有选区所有权），因此合并为一条复合命令 */
  async pasteText(text: string): Promise<boolean> {
    if (!this.wslReady) return false
    return ops.pasteText(text)
  }

  /** 列出桌面窗口 — xdotool 自身即可枚举，无需 wmctrl */
  async listWindows(): Promise<{ id: string; title: string }[]> {
    if (!this.wslReady) return []
    return ops.listWindows()
  }

  // -----------------------------------------------------------------------
  // 桌面应用能力库（已移除 — 用户可让 Agent 在桌面内自行安装）
  // -----------------------------------------------------------------------
}

export const agentWorkspaceManager = new AgentWorkspaceManagerImpl()
// 原单文件导出的常量 — 现由 wsl-exec 模块持有，此处保持原导出路径不变
export { WSL_STREAM_PORT, WSL_STREAM_URL } from './wsl-exec'
