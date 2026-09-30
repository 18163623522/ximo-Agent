/**
 * 集成测试 — IPC 通道契约（main 注册 ↔ preload 引用 双向校验）
 *
 * 本项目 IPC 通道名是字符串契约（main 侧 ipcMain.handle / preload 侧 invoke），
 * 拼写错一个字前后端就静默断联。本测试把全部主进程注册器真实跑一遍收集注册表，
 * 再静态扫描 preload 源码引用的通道，双向对账：
 *   1. preload invoke 的每个通道必须已在 main 注册（断联 = 红灯）
 *   2. preload .on 订阅的事件通道必须有 main 侧 webContents.send 对应
 *   3. main 侧无重复注册（重复注册 Electron 会抛错）
 * 拆分/新增 handler 文件后跑这个文件，防止通道漂移。
 */
import { describe, it, expect, vi, beforeAll } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'fs'
import { join } from 'path'

const h = vi.hoisted(() => ({
  handleCalls: [] as [string, unknown][],
  onCalls: [] as [string, unknown][],
}))

vi.mock('electron', () => ({
  ipcMain: {
    handle: (ch: string, fn: unknown): void => { h.handleCalls.push([ch, fn]) },
    on: (ch: string, fn: unknown): void => { h.onCalls.push([ch, fn]) },
  },
  BrowserWindow: { getAllWindows: () => [] },
  app: {
    getPath: () => 'C:\\ximo-test-data',
    whenReady: () => Promise.resolve(),
    getName: () => 'ximo-Agent',
    getVersion: () => '0.0.0-test',
    isPackaged: false,
    getLoginItemSettings: () => ({}),
  },
  Notification: { isSupported: () => false },
  protocol: { handle: vi.fn() },
  net: { fetch: vi.fn(), isOnline: () => true },
  dialog: { showMessageBox: vi.fn(async () => ({ response: 0 })), showOpenDialog: vi.fn(async () => ({ canceled: true })), showSaveDialog: vi.fn(async () => ({ canceled: true })) },
  clipboard: { readText: vi.fn(() => ''), writeText: vi.fn() },
  shell: { openExternal: vi.fn(async () => true), openPath: vi.fn(async () => '') },
  powerMonitor: { on: vi.fn() },
  nativeTheme: { on: vi.fn(), shouldUseDarkColors: true },
  screen: { getPrimaryDisplay: vi.fn(() => ({ size: { width: 1920, height: 1080 } })), on: vi.fn() },
  systemPreferences: { getUserDefault: vi.fn(() => undefined) },
  session: { defaultSession: {} },
  safeStorage: { isEncryptionAvailable: () => false },
}))

import { registerChatHandlers } from '../../src/main/ipc/chat-handler'
import { registerSystemHandlers } from '../../src/main/ipc/system-handlers'
import { registerFsHandlers } from '../../src/main/ipc/fs-handlers'
import { registerDataHandlers } from '../../src/main/ipc/data-handlers'
import { registerNetworkHandlers } from '../../src/main/ipc/network-handlers'
import { registerUpdateHandlers } from '../../src/main/ipc/update-handlers'
import { registerVoiceHandlers } from '../../src/main/voice/voice-ipc'

// 注册器函数体内动态 import 的模块引用了 electron-updater（update-handlers），统一打桩
vi.mock('electron-updater', () => ({ autoUpdater: { on: vi.fn(), checkForUpdates: vi.fn(), quitAndInstall: vi.fn() } }))

// 与生产 index.ts 同路径：真实执行全部注册器（WebviewBridge 为模块加载式注册）。
// 注意：enhance-prompt 由 registerChatHandlers 链内调用，这里不能重复调（会重复注册）。
beforeAll(() => {
  registerChatHandlers()
  registerSystemHandlers()
  registerFsHandlers()
  registerDataHandlers()
  registerNetworkHandlers()
  registerUpdateHandlers()
  registerVoiceHandlers()
  return import('../../src/main/tools/Browser/WebviewBridge')
})

function walkTs(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) out.push(...walkTs(p))
    else if (name.endsWith('.ts')) out.push(p)
  }
  return out
}

function scanChannels(src: string): { invoke: string[]; on: string[]; send: string[] } {
  // 剥离注释 — 说明文字里可能出现 invoke('xxx') 等字样，不是真实引用
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  const invoke = [...code.matchAll(/invoke\(\s*'([^']+)'/g)].map(x => x[1])
  const on = [...code.matchAll(/\.on\(\s*'([^']+)'/g)].map(x => x[1])
  const send = [...code.matchAll(/\.send\(\s*'([^']+)'/g)].map(x => x[1])
  return { invoke, on, send }
}

describe('IPC 通道契约 — main 注册 ↔ preload 引用', () => {
  // 惰性读取 — describe 回调在收集期执行，注册发生在 beforeAll
  const registeredHandle = (): string[] => h.handleCalls.map(c => c[0])

  it('全部注册器可加载且真实执行注册（含拆分后的 8 个子 handler 文件）', () => {
    expect(registeredHandle().length).toBeGreaterThan(50) // 当前 60+ 个 invoke 通道
  })
  it('main 侧无重复注册（重复 handle 同名会被 Electron 抛错）', () => {
    const all = registeredHandle()
    expect(new Set(all).size).toBe(all.length)
  })

  it('preload invoke 的每个通道都已在 main 注册（防拼写漂移/断联）', () => {
    const preloadFiles = [
      'src/preload/index.ts',
      ...readdirSync('src/shared/preload-api').map(f => join('src/shared/preload-api', f)),
    ]
    const referenced: string[] = []
    for (const f of preloadFiles) {
      referenced.push(...scanChannels(readFileSync(f, 'utf-8')).invoke)
    }
    expect(referenced.length).toBeGreaterThan(40)
    // window:ready 由 window-manager.ts 的 createWindow() 在运行时注册（不在 IPC 注册器内），
    // 本测试未驱动窗口创建流程，故显式豁免
    const RUNTIME_REGISTERED = new Set(['window:ready'])
    const missing = [...new Set(referenced)].filter(ch => !registeredHandle().includes(ch) && !RUNTIME_REGISTERED.has(ch))
    expect(missing, `preload 引用但 main 未注册的通道: ${missing.join(', ')}`).toEqual([])
  })

  it('preload .on 订阅的事件通道都有 main 侧 webContents.send 对应', () => {
    const preloadFiles = [
      'src/preload/index.ts',
      ...readdirSync('src/shared/preload-api').map(f => join('src/shared/preload-api', f)),
    ]
    const subscribed: string[] = []
    for (const f of preloadFiles) {
      subscribed.push(...scanChannels(readFileSync(f, 'utf-8')).on)
    }
    // main 侧推送 = WebContents.send（含 win/event.sender 等变量接收者），宽匹配 .send(
    const pushed = new Set<string>()
    for (const f of walkTs('src/main')) {
      for (const match of readFileSync(f, 'utf-8').matchAll(/\.send\(\s*'([^']+)'/g)) {
        pushed.add(match[1])
      }
    }
    const missing = [...new Set(subscribed)].filter(ch => !pushed.has(ch))
    expect(missing, `preload 订阅但 main 侧无人推送的事件: ${missing.join(', ')}`).toEqual([])
  })

  it('关键通道抽查 — 本轮新增/拆分相关通道必须在册', () => {
    for (const ch of [
      'chat:start', 'chat:cancel', 'chat:test',
      'agent-system:definitions:list', 'agent-system:instances:start', 'agent-system:instances:stop',
      'assist:get', 'assist:set', 'assist:respond',
      'schedule:create', 'schedule:setPaused',
      'workspace:exec', 'workspace:launch', 'virtual-desktop:list',
      'window:minimize', 'checkpoint:list',
    ]) {
      expect(registeredHandle(), `通道未注册: ${ch}`).toContain(ch)
    }
  })
})
