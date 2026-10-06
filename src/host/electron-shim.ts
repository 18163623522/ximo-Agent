/**
 * electron-shim — 在纯 Node（Linux 主机/VM）里运行主应用模块时的 electron 替身
 *
 * 主机运行时复用主应用代码（store/paths/deepseek 层/可移植工具域），这些模块对
 * electron 的实际依赖面只有 app.getPath / BrowserWindow / Notification / safeStorage
 * 等表面 API。本模块在 CJS 运行时通过 Module._resolveFilename 钩子把 'electron'
 * 重定向到自身（注册进 require.cache）；vitest/ESM 路径不经过该钩子（由 vi.mock 提供）。
 *
 * app.getPath('userData') 可用 XIMO_HOST_USERDATA 覆盖，缺省在主机数据目录下。
 */
import { Module } from 'module'
import { homedir } from 'os'
import { join } from 'path'

const USER_DATA_DIR = process.env.XIMO_HOST_USERDATA
  || join(process.env.XIMO_HOST_DATA || join(homedir(), '.local', 'share', 'ximo-host'), 'app')

const noop = (): void => {}

const electronShim = {
  app: {
    getPath: (name: string): string => (name === 'userData' ? USER_DATA_DIR : join(USER_DATA_DIR, name)),
    whenReady: (): Promise<void> => Promise.resolve(),
    isReady: (): boolean => true,
    isPackaged: true,
    getName: (): string => 'ximo-host',
    getVersion: (): string => '0.0.0-host',
    on: noop,
    once: noop,
    quit: noop,
    exit: noop,
    relaunch: noop,
    setLoginItemSettings: noop,
    getLoginItemSettings: (): Record<string, unknown> => ({}),
    setAppUserModelId: noop,
  },
  BrowserWindow: Object.assign(
    function FakeBrowserWindow(this: unknown): void { /* 主机运行时不创建窗口 */ },
    { getAllWindows: (): unknown[] => [], fromWebContents: (): null => null }
  ),
  Notification: Object.assign(
    function FakeNotification(this: unknown): void {},
    { isSupported: (): boolean => false }
  ),
  ipcMain: { handle: noop, on: noop, once: noop, off: noop, removeHandler: noop, removeAllListeners: noop },
  ipcRenderer: {},
  dialog: {
    showOpenDialog: async (): Promise<{ canceled: boolean }> => ({ canceled: true }),
    showSaveDialog: async (): Promise<{ canceled: boolean }> => ({ canceled: true }),
    showMessageBox: async (): Promise<{ response: number }> => ({ response: 1 }),
  },
  clipboard: { readText: (): string => '', writeText: noop, readImage: (): null => null, writeImage: noop },
  shell: {
    openExternal: async (): Promise<boolean> => true,
    openPath: async (): Promise<string> => '',
    showItemInFolder: noop,
    trashItem: async (): Promise<void> => undefined,
    beep: noop,
  },
  net: {
    fetch: (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => fetch(input, init),
    isOnline: (): boolean => true,
  },
  protocol: { handle: noop, registerFileProtocol: noop, registerSchemesAsPrivileged: noop },
  screen: {
    getPrimaryDisplay: () => ({ size: { width: 1920, height: 1080 }, workAreaSize: { width: 1920, height: 1040 } }),
    on: noop,
  },
  nativeTheme: { on: noop, shouldUseDarkColors: true, themeSource: 'system' },
  systemPreferences: { on: noop, getUserDefault: (): undefined => undefined },
  powerMonitor: { on: noop },
  session: { defaultSession: { on: noop } },
  safeStorage: {
    isEncryptionAvailable: (): boolean => false,
    encryptString: (s: string): Buffer => Buffer.from(s, 'utf-8'),
    decryptString: (b: Buffer): Buffer => Buffer.from(b),
  },
  webFrame: {},
  crashReporter: { start: noop },
  contextBridge: { exposeInMainWorld: noop },
}

// 未知成员兜底 — 可移植模块迭代新增 API 时告警而非硬崩
const shimProxy = new Proxy(electronShim, {
  get(target, prop, receiver) {
    if (prop in target) return Reflect.get(target, prop, receiver)
    console.warn(`[electron-shim] 未覆盖的 electron API: ${String(prop)} — 返回 no-op`)
    return noop
  },
})

// CJS 钩子 — 生产路径（node dist-host）：'electron' → 本 shim；'@main/@shared' 别名 → dist-host 实际路径
// （tsc 不重写产物里的路径别名；vitest/ESM 路径由 vitest alias + vi.mock 处理，不走此钩子）
const ModuleCjs = Module as unknown as {
  _resolveFilename?: (this: unknown, request: string, ...rest: unknown[]) => string
  _cache: Record<string, unknown>
  __ximoShimPatched?: boolean
}
if (!ModuleCjs.__ximoShimPatched && typeof ModuleCjs._resolveFilename === 'function') {
  ModuleCjs._cache['ximo-electron-shim'] = {
    id: 'ximo-electron-shim',
    filename: 'ximo-electron-shim',
    loaded: true,
    exports: shimProxy,
  }
  let hostDist: string | null = null
  try { hostDist = join(__dirname, '..') } catch { /* ESM 环境（vitest）：无需运行时重写 */ }
  const original = ModuleCjs._resolveFilename
  ModuleCjs._resolveFilename = function (request: string, ...rest: unknown[]) {
    if (request === 'electron') return 'ximo-electron-shim'
    if (hostDist) {
      if (request.startsWith('@main/')) {
        return original.apply(this, [join(hostDist, 'main', request.slice(6)), ...rest] as unknown as Parameters<NonNullable<typeof original>>)
      }
      if (request.startsWith('@shared/')) {
        return original.apply(this, [join(hostDist, 'shared', request.slice(8)), ...rest] as unknown as Parameters<NonNullable<typeof original>>)
      }
    }
    return original.apply(this, [request, ...rest] as unknown as Parameters<NonNullable<typeof original>>)
  }
  ModuleCjs.__ximoShimPatched = true
}

export default shimProxy
