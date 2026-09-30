/**
 * VirtualDesktopManager — Agent 隔离工作区管理器
 *
 * 设计灵感：agent-workspace-linux（https://github.com/agent-sh/agent-workspace-linux）
 * ——给 Agent 一个独占的、隔离的工作环境，不依赖 OS 原生虚拟桌面。
 *
 * 核心机制：应用层窗口逻辑分组 + Win32 ShowWindowAsync
 *
 * - 每个虚拟桌面 = 一组窗口句柄（HWND）的逻辑分组
 * - "切换桌面" = 最小化所有非目标桌面的窗口，恢复目标桌面的窗口
 * - 窗口枚举通过极简 PowerShell（Add-Type + EnumWindows），无 COM 依赖
 * - 窗口操作通过 Win32 ShowWindowAsync（最小化/恢复/聚焦）
 * - 桌面状态持久化到 userData/agent-workspace.json
 *
 * 与 OS 原生虚拟桌面的区别：
 * - 不依赖 IVirtualDesktopManager COM 接口（避免 Access Denied / GUID 不匹配）
 * - 不需要 ImmersiveShell / IServiceProvider
 * - 完全在应用层管理，跨 Windows 版本一致
 * - Agent 可以自由创建、命名、销毁工作区，不影响用户真实桌面布局
 */

import { execFile } from 'child_process'
import { promisify } from 'util'
import { join } from 'path'
import { app } from 'electron'
import { readFile, writeFile, mkdir } from 'fs/promises'
import type { VirtualDesktopInfo, DesktopWindowInfo, DesktopActionResult } from '@shared/types'
import { buildPsCommand } from './VirtualDesktopCommands'
import type { WorkspaceState } from './VirtualDesktopTypes'

const execFileAsync = promisify(execFile)

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

const POWERSHELL_TIMEOUT = 15_000
const PS_EXECUTABLE = process.env.SystemRoot
  ? join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  : 'powershell.exe'


// ---------------------------------------------------------------------------
// 核心类
// ---------------------------------------------------------------------------

class VirtualDesktopManagerImpl {
  private state: WorkspaceState = { desktops: [], activeDesktopId: '' }
  private stateLoaded = false
  private stateFilePath: string | null = null

  // -----------------------------------------------------------------------
  // 状态持久化
  // -----------------------------------------------------------------------

  private async getStateFilePath(): Promise<string> {
    if (this.stateFilePath) return this.stateFilePath
    const dir = app.getPath('userData')
    try { await mkdir(dir, { recursive: true }) } catch { /* 已存在 */ }
    this.stateFilePath = join(dir, 'agent-workspace.json')
    return this.stateFilePath
  }

  private async loadState(): Promise<void> {
    if (this.stateLoaded) return
    try {
      const path = await this.getStateFilePath()
      const raw = await readFile(path, 'utf-8')
      const parsed = JSON.parse(raw) as WorkspaceState
      if (parsed.desktops && Array.isArray(parsed.desktops)) {
        this.state = parsed
      }
    } catch {
      // 文件不存在或解析失败 — 初始化默认状态
      this.state = {
        desktops: [{ id: 'default', name: '主桌面', hwnds: [] }],
        activeDesktopId: 'default',
      }
      await this.saveState()
    }
    this.stateLoaded = true
  }

  private async saveState(): Promise<void> {
    try {
      const path = await this.getStateFilePath()
      await writeFile(path, JSON.stringify(this.state, null, 2), 'utf-8')
    } catch {
      // 持久化失败不阻断操作
    }
  }

  // -----------------------------------------------------------------------
  // PowerShell 执行
  // -----------------------------------------------------------------------

  private async runPs(command: string, env?: Record<string, string>): Promise<unknown> {
    const args = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', command]
    try {
      const { stdout } = await execFileAsync(PS_EXECUTABLE, args, {
        timeout: POWERSHELL_TIMEOUT,
        windowsHide: true,
        maxBuffer: 4 * 1024 * 1024,
        env: { ...process.env, ...env },
      })
      const trimmed = stdout.trim()
      if (!trimmed) return null
      return JSON.parse(trimmed)
    } catch (e) {
      throw new Error(`PowerShell 执行失败: ${(e as Error).message}`)
    }
  }

  // -----------------------------------------------------------------------
  // 窗口枚举
  // -----------------------------------------------------------------------

  private async enumVisibleWindows(): Promise<DesktopWindowInfo[]> {
    const data = await this.runPs(buildPsCommand('enum'))
    if (!data) return []
    const items = Array.isArray(data) ? data : [data]
    return items.map((w: Record<string, unknown>) => ({
      hwnd: String(w.hwnd ?? ''),
      title: String(w.title ?? ''),
      appName: String(w.app ?? ''),
      desktopId: '',
      isFocused: Boolean(w.isFocused),
      bounds: {
        x: Number(w.x ?? 0),
        y: Number(w.y ?? 0),
        width: Number(w.w ?? 0),
        height: Number(w.h ?? 0),
      },
    }))
  }

  // -----------------------------------------------------------------------
  // 公开 API
  // -----------------------------------------------------------------------

  /**
   * 列出所有虚拟桌面
   * 同时刷新窗口计数（将未分配的窗口归入主桌面）
   */
  async list(): Promise<DesktopActionResult> {
    await this.loadState()

    // 枚举当前可见窗口
    const allWindows = await this.enumVisibleWindows()

    // 清理已不存在的 hwnd（窗口已关闭）
    const liveHwnds = new Set(allWindows.map((w) => w.hwnd))
    for (const d of this.state.desktops) {
      d.hwnds = d.hwnds.filter((h) => liveHwnds.has(String(h)))
    }

    // 将未分配的窗口归入主桌面
    const assignedHwnds = new Set(this.state.desktops.flatMap((d) => d.hwnds.map((h) => String(h))))
    const defaultDesktop = this.state.desktops.find((d) => d.id === 'default') ?? this.state.desktops[0]
    if (defaultDesktop) {
      for (const w of allWindows) {
        if (!assignedHwnds.has(w.hwnd)) {
          defaultDesktop.hwnds.push(Number(w.hwnd))
        }
      }
    }

    await this.saveState()

    const desktops: VirtualDesktopInfo[] = this.state.desktops.map((d) => ({
      id: d.id,
      name: d.name,
      isActive: d.id === this.state.activeDesktopId,
      windowCount: d.hwnds.length,
    }))

    return { success: true, desktops }
  }

  /**
   * 切换到指定桌面
   * 最小化所有非目标桌面的窗口，恢复目标桌面的窗口
   */
  async switch(desktopId: string): Promise<DesktopActionResult> {
    await this.loadState()

    const target = this.state.desktops.find((d) => d.id === desktopId)
    if (!target) return { success: false, error: `桌面不存在: ${desktopId}` }

    // 收集需要最小化的窗口（所有非目标桌面的窗口）
    const toMinimize: number[] = []
    for (const d of this.state.desktops) {
      if (d.id !== desktopId) {
        toMinimize.push(...d.hwnds)
      }
    }

    // 先最小化
    if (toMinimize.length > 0) {
      await this.runPs(
        buildPsCommand('minimize_all'),
        { VD_HWNDS: toMinimize.join(',') }
      )
    }

    // 再恢复目标桌面的窗口
    if (target.hwnds.length > 0) {
      await this.runPs(
        buildPsCommand('restore_all'),
        { VD_HWNDS: target.hwnds.join(',') }
      )
    }

    this.state.activeDesktopId = desktopId
    await this.saveState()

    return { success: true }
  }

  /**
   * 创建新桌面
   */
  async create(name?: string): Promise<DesktopActionResult> {
    await this.loadState()

    const id = `ws_${Date.now()}`
    const desktopName = name || `工作区 ${this.state.desktops.length + 1}`
    this.state.desktops.push({ id, name: desktopName, hwnds: [] })
    await this.saveState()

    // 返回更新后的桌面列表
    return this.list()
  }

  /**
   * 删除桌面 — 将其窗口合并到主桌面
   */
  async remove(desktopId: string): Promise<DesktopActionResult> {
    await this.loadState()

    if (this.state.desktops.length <= 1) {
      return { success: false, error: '至少需要保留一个桌面' }
    }

    const target = this.state.desktops.find((d) => d.id === desktopId)
    if (!target) return { success: false, error: `桌面不存在: ${desktopId}` }

    // 将窗口合并到主桌面
    const main = this.state.desktops.find((d) => d.id === 'default') ?? this.state.desktops.find((d) => d.id !== desktopId)
    if (main && target.hwnds.length > 0) {
      main.hwnds.push(...target.hwnds)
    }

    this.state.desktops = this.state.desktops.filter((d) => d.id !== desktopId)

    // 如果删除的是活跃桌面，切换到主桌面
    if (this.state.activeDesktopId === desktopId) {
      this.state.activeDesktopId = main?.id ?? this.state.desktops[0].id
    }

    await this.saveState()

    // 执行一次切换以恢复窗口
    await this.switch(this.state.activeDesktopId)

    return this.list()
  }

  /**
   * 重命名桌面
   */
  async rename(desktopId: string, newName: string): Promise<DesktopActionResult> {
    await this.loadState()

    const target = this.state.desktops.find((d) => d.id === desktopId)
    if (!target) return { success: false, error: `桌面不存在: ${desktopId}` }

    target.name = newName
    await this.saveState()

    return this.list()
  }

  /**
   * 列出桌面上的窗口
   */
  async listWindows(desktopId?: string): Promise<DesktopActionResult> {
    await this.loadState()

    const targetId = desktopId || this.state.activeDesktopId
    const target = this.state.desktops.find((d) => d.id === targetId)
    if (!target) return { success: false, error: `桌面不存在: ${targetId}` }

    // 枚举所有可见窗口
    const allWindows = await this.enumVisibleWindows()
    const hwndSet = new Set(target.hwnds.map((h) => String(h)))

    // 过滤出属于此桌面的窗口
    const windows = allWindows
      .filter((w) => hwndSet.has(w.hwnd))
      .map((w) => ({ ...w, desktopId: target.id }))

    return { success: true, windows }
  }

  /**
   * 将窗口移动到指定桌面
   */
  async moveWindow(windowTitle: string, desktopId?: string): Promise<DesktopActionResult> {
    await this.loadState()

    const allWindows = await this.enumVisibleWindows()
    const matched = allWindows.filter((w) =>
      w.title.toLowerCase().includes(windowTitle.toLowerCase())
    )

    if (matched.length === 0) {
      return { success: false, error: `未找到匹配的窗口: ${windowTitle}` }
    }

    const targetId = desktopId || this.state.activeDesktopId
    const target = this.state.desktops.find((d) => d.id === targetId)
    if (!target) return { success: false, error: `桌面不存在: ${targetId}` }

    // 从其他桌面移除，添加到目标桌面
    for (const w of matched) {
      for (const d of this.state.desktops) {
        d.hwnds = d.hwnds.filter((h) => String(h) !== w.hwnd)
      }
      target.hwnds.push(Number(w.hwnd))
    }

    await this.saveState()

    return { success: true }
  }

  /**
   * 聚焦指定窗口
   */
  async focusWindow(windowTitle: string): Promise<DesktopActionResult> {
    await this.loadState()

    const allWindows = await this.enumVisibleWindows()
    const matched = allWindows.find((w) =>
      w.title.toLowerCase().includes(windowTitle.toLowerCase())
    )

    if (!matched) {
      return { success: false, error: `未找到匹配的窗口: ${windowTitle}` }
    }

    await this.runPs(
      buildPsCommand('focus'),
      { VD_HWND: matched.hwnd }
    )

    return { success: true }
  }
}

export const virtualDesktopManager = new VirtualDesktopManagerImpl()
