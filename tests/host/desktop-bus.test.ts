/**
 * desktop-bus 测试（阶段 2）— 总线路由 + 解析 + 协议回路
 *
 * X 会话不可用于 CI/本机单测：执行层全部注入 fake 后端（run/launch/appName），
 * 同一套解析与路由逻辑被真实驱动；协议回路段用真 createHostServer +
 * 真 HostClient 验证 desktop.request → desktop.reply 全链路。
 */
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'
import { tmpdir } from 'os'
import { join } from 'path'
import { mkdirSync } from 'fs'
import { DesktopBus } from '../../src/host/desktop/bus'
import { parseWmctrl } from '../../src/host/desktop/backend'
import { createHostServer, HostServer } from '../../src/host/server'
import { HostClient } from '../../src/main/host/HostClient'
import type { HostStatusInfo, HostMsg, HostTaskRecord, DesktopWindow } from '../../src/shared/types'

// ---------- electron mock（server → task-runner 链需要） ----------

const TEST_ROOT = join(tmpdir(), `ximo-desktop-test-${Date.now()}`)
const m = vi.hoisted(() => ({ userData: '' }))
beforeAll(() => {
  m.userData = join(TEST_ROOT, 'app')
  mkdirSync(m.userData, { recursive: true })
  process.env.XIMO_HOST_DIR = join(TEST_ROOT, 'config')
  process.env.XIMO_HOST_DATA = join(TEST_ROOT, 'data')
  mkdirSync(process.env.XIMO_HOST_DIR, { recursive: true })
})

vi.mock('electron', () => {
  const noop = (): void => undefined
  return {
    app: {
      getPath: (name: string): string => join(m.userData, name === 'userData' ? '' : name),
      whenReady: async (): Promise<void> => undefined,
      isReady: (): boolean => true,
      isPackaged: true,
      getName: (): string => 'ximo-host',
      getVersion: (): string => '0.0.0-test',
      on: noop, once: noop, quit: noop, exit: noop, relaunch: noop,
      setLoginItemSettings: noop,
      getLoginItemSettings: (): Record<string, unknown> => ({}),
      setAppUserModelId: noop,
    },
    BrowserWindow: Object.assign(function FakeBrowserWindow(this: unknown): void {}, {
      getAllWindows: (): unknown[] => [],
    }),
    Notification: Object.assign(function FakeNotification(this: unknown): void {}, {
      isSupported: (): boolean => false,
    }),
    ipcMain: { handle: noop, on: noop, once: noop, off: noop, removeHandler: noop, removeAllListeners: noop },
    ipcRenderer: {},
    dialog: { showOpenDialog: async (): Promise<{ canceled: boolean }> => ({ canceled: true }), showSaveDialog: async (): Promise<{ canceled: boolean }> => ({ canceled: true }), showMessageBox: async (): Promise<{ response: number }> => ({ response: 1 }) },
    clipboard: { readText: (): string => '', writeText: noop, readImage: (): null => null, writeImage: noop },
    shell: { openExternal: async (): Promise<boolean> => true, openPath: async (): Promise<string> => '', showItemInFolder: noop, trashItem: async (): Promise<void> => undefined, beep: noop },
    net: { fetch: (...a: unknown[]) => fetch(...(a as [Parameters<typeof fetch>[0]])), isOnline: (): boolean => true },
    protocol: { handle: noop, registerFileProtocol: noop, registerSchemesAsPrivileged: noop },
    screen: { getPrimaryDisplay: () => ({ size: { width: 1920, height: 1080 } }), on: noop },
    nativeTheme: { on: noop, shouldUseDarkColors: true },
    systemPreferences: { on: noop, getUserDefault: (): undefined => undefined },
    powerMonitor: { on: noop },
    session: { defaultSession: { on: noop } },
    safeStorage: { isEncryptionAvailable: (): boolean => false },
  }
})

// ---------- fake 后端 ----------

const WMCTRL_OUT = [
  '0x03c00007  0 12345 host 52 52 1176 696 终端 — xfce4-terminal',
  '0x03c00011  0 12346 host 0 0 1280 800 Firefox',
  '',
].join('\n')

function fakeRun(overrides: Record<string, string> = {}) {
  const calls: { cmd: string; args: string[] }[] = []
  const run = vi.fn(async (cmd: string, args: string[]): Promise<string> => {
    calls.push({ cmd, args })
    if (overrides[cmd] !== undefined) return overrides[cmd]
    if (cmd === 'wmctrl') return WMCTRL_OUT
    if (cmd === 'xdotool' && args[0] === 'getactivewindow') return '0x03c00007'
    return ''
  })
  return { run, calls }
}

const fakeDeps = (run: ReturnType<typeof fakeRun>['run']) => ({
  display: ':99',
  run,
  launch: vi.fn((_app: string, _args: string[]) => ({ pid: 4321 })),
  appName: (pid: number): string => (pid === 12345 ? 'xfce4-terminal' : pid === 12346 ? 'firefox' : ''),
})

// ---------- 总线单测 ----------

describe('desktop-bus — 路由与解析', () => {
  it('window.list 解析 wmctrl 输出并补齐应用名', async () => {
    const f = fakeRun()
    const bus = new DesktopBus(fakeDeps(f.run))
    const windows = await bus.dispatch('window.list') as DesktopWindow[]
    expect(windows).toHaveLength(2)
    expect(windows[0]).toMatchObject({ id: '0x03c00007', pid: 12345, app: 'xfce4-terminal', title: '终端 — xfce4-terminal', x: 52, y: 52, w: 1176, h: 696 })
    expect(windows[1].app).toBe('firefox')
  })

  it('window.op activate — 命令参数正确，title 子串可定位窗口', async () => {
    const f = fakeRun()
    const bus = new DesktopBus(fakeDeps(f.run))
    const res = await bus.dispatch('window.op', { op: 'activate', title: 'Firefox' }) as { done: boolean }
    expect(res.done).toBe(true)
    expect(f.calls.at(-1)).toEqual({ cmd: 'wmctrl', args: ['-i', '-a', '0x03c00011'] })
  })

  it('window.op move/resize — -1 缺省保持不变', async () => {
    const f = fakeRun()
    const bus = new DesktopBus(fakeDeps(f.run))
    await bus.dispatch('window.op', { op: 'resize', window_id: '0x03c00007', w: 800, h: 600 })
    expect(f.calls.at(-1)).toEqual({ cmd: 'wmctrl', args: ['-i', '-r', '0x03c00007', '-e', '0,-1,-1,800,600'] })
  })

  it('type — 文本作为单个 execFile 参数（无 shell 注入面）', async () => {
    const f = fakeRun()
    const bus = new DesktopBus(fakeDeps(f.run))
    const evil = 'rm -rf /; $(pwn) `x` "q"'
    await bus.dispatch('type', { text: evil })
    expect(f.calls.at(-1)).toEqual({ cmd: 'xdotool', args: ['type', '--delay', '15', '--', evil] })
  })

  it('app.launch — 经注入的启动器脱离会话执行', async () => {
    const f = fakeRun()
    const deps = fakeDeps(f.run)
    const bus = new DesktopBus(deps)
    const res = await bus.dispatch('app.launch', { app: 'xfce4-terminal', args: ['--tab'] }) as { pid?: number }
    expect(res.pid).toBe(4321)
    expect(deps.launch).toHaveBeenCalledWith('xfce4-terminal', ['--tab'])
  })

  it('参数缺失 / 未知动作 — 可读错误', async () => {
    const bus = new DesktopBus(fakeDeps(fakeRun().run))
    await expect(bus.dispatch('type', {})).rejects.toThrow('text 参数必填')
    await expect(bus.dispatch('window.op', {})).rejects.toThrow('op ∈')
    await expect(bus.dispatch('window.op', { op: 'activate' })).rejects.toThrow('window_id 或 title')
    await expect(bus.dispatch('window.op', { op: 'boom' })).rejects.toThrow('op ∈')
    await expect(bus.dispatch('app.launch', {})).rejects.toThrow('app.launch 需要 app 参数')
    // @ts-expect-error 故意传非法 action（运行时防御）
    await expect(bus.dispatch('hack.system')).rejects.toThrow('未知的桌面操作')
  })

  it('X 工具缺失（ENOENT）— 归因可读', async () => {
    const bus = new DesktopBus({
      display: ':99',
      run: async () => { throw new Error("spawn wmctrl ENOENT: file not found") },
    })
    await expect(bus.dispatch('window.list')).rejects.toThrow('X 工具未安装')
  })

  it('display 为空 — 桌面功能停用', async () => {
    const bus = new DesktopBus({ display: '' })
    await expect(bus.dispatch('window.list')).rejects.toThrow('未启用')
  })

  it('事件轮询 — 窗口集合变化即推完整快照', async () => {
    let out = WMCTRL_OUT
    const f = fakeRun()
    f.run.mockImplementation(async (cmd: string): Promise<string> => (cmd === 'wmctrl' ? out : ''))
    const bus = new DesktopBus(fakeDeps(f.run as never))
    const events: unknown[] = []
    const off = bus.onEvent((e) => events.push(e))

    await bus.checkEvents()
    expect(events).toHaveLength(0) // 首轮只建立基线

    out = WMCTRL_OUT.replace('0x03c00011', '0x03c00099') // 窗口集合变化
    await bus.checkEvents()
    expect(events).toHaveLength(1)
    expect((events[0] as { kind: string }).kind).toBe('window')
    expect((events[0] as { data: DesktopWindow[] }).data.some((w) => w.id === '0x03c00099')).toBe(true)

    off()
    out = WMCTRL_OUT
    await bus.checkEvents()
    expect(events).toHaveLength(1) // 无订阅者不再轮询
  })
})

describe('desktop-bus — 协议回路（真 server + 真 HostClient）', () => {
  const TOKEN = 'desktop-test-token'
  const servers: HostServer[] = []
  const clients: HostClient[] = []
  afterAll(async () => {
    for (const c of clients) c.dispose()
    for (const s of servers) await s.close()
  })

  async function makeSetup(port: number): Promise<{ server: HostServer; client: HostClient }> {
    const f = fakeRun()
    const bus = new DesktopBus(fakeDeps(f.run))
    const server = createHostServer({
      config: { listen: `127.0.0.1:${port}`, display: ':99' },
      token: TOKEN,
      deps: { desktopBus: bus },
    })
    await server.start()
    servers.push(server)
    const events: HostMsg[] = []
    const client = new HostClient({
      status: (_s: HostStatusInfo) => {},
      tasks: (_t: HostTaskRecord[]) => {},
      event: (msg: HostMsg) => { events.push(msg) },
    })
    clients.push(client)
    client.connect(`http://127.0.0.1:${port}`, TOKEN)
    return { server, client }
  }

  it('desktop.request → desktop.reply 携带结构化窗口数据', { timeout: 20_000 }, async () => {
    const { client } = await makeSetup(18121)
    await vi.waitFor(() => {
      if (!client.isConnected()) throw new Error('尚未连接')
    }, { timeout: 10_000, interval: 50 })

    const res = await client.desktopRequest('window.list')
    expect(res.ok).toBe(true)
    const windows = res.data as DesktopWindow[]
    expect(windows).toHaveLength(2)
    expect(windows[0].app).toBe('xfce4-terminal')
  }, 20_000)

  it('desktop.request 错误路径 — window.op 缺参数 → reply(ok=false)', { timeout: 20_000 }, async () => {
    const { client } = await makeSetup(18122)
    await vi.waitFor(() => {
      if (!client.isConnected()) throw new Error('尚未连接')
    }, { timeout: 10_000, interval: 50 })

    const res = await client.desktopRequest('window.op', { window_id: '0x03c00007' })
    expect(res.ok).toBe(false)
    expect(res.error).toContain('op ∈')
  })
})
