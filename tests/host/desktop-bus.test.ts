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
import { parseWmctrl, type RunFn } from '../../src/host/desktop/backend'
import { createHostServer, HostServer } from '../../src/host/server'
import { ScreenCapture } from '../../src/host/desktop/screen'
import { HostClient } from '../../src/main/host/HostClient'
import type { HostStatusInfo, HostMsg, HostTaskRecord, DesktopWindow, DesktopScreenSize } from '../../src/shared/types'

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

  it('鼠标注入 — click/scroll 命令参数正确（xdotool 键位编码）', async () => {
    const f = fakeRun()
    const bus = new DesktopBus(fakeDeps(f.run))
    await bus.dispatch('mouse.click', { x: 120, y: 80, button: 'right' })
    expect(f.calls.at(-1)).toEqual({ cmd: 'xdotool', args: ['mousemove', '120', '80', 'click', '3'] })
    await bus.dispatch('mouse.scroll', { x: 10, y: 20, direction: 'up', amount: 3 })
    expect(f.calls.at(-1)).toEqual({ cmd: 'xdotool', args: ['mousemove', '10', '20', 'click', '--repeat', '3', '4'] })
    await bus.dispatch('mouse.move', { x: 55.7, y: 'abc' })
    expect(f.calls.at(-1)).toEqual({ cmd: 'xdotool', args: ['mousemove', '56', '0'] }) // 强转取整；NaN → 0
  })

  it('screen.size — 解析 getdisplaygeometry 输出', async () => {
    const f = fakeRun()
    f.run.mockImplementation(async (cmd: string, args: string[]): Promise<string> =>
      cmd === 'xdotool' && args[0] === 'getdisplaygeometry' ? '1280 800' : '')
    const bus = new DesktopBus(fakeDeps(f.run as never))
    const size = await bus.dispatch('screen.size') as DesktopScreenSize
    expect(size).toEqual({ width: 1280, height: 800 })
  })

  it('剪贴板 — 读走 xclip -o；写把文本经 stdin 喂给 xclip -i', async () => {
    const calls: { cmd: string; args: string[]; stdin?: string }[] = []
    const run: RunFn = async (cmd, args, _t, stdin) => {
      calls.push({ cmd, args, stdin })
      return cmd === 'xclip' && args.includes('-o') ? '文档正文内容' : ''
    }
    const bus = new DesktopBus({ display: ':99', run })

    const read = await bus.dispatch('clipboard.read') as { text: string }
    expect(read.text).toBe('文档正文内容')
    expect(calls[0]).toEqual({ cmd: 'xclip', args: ['-selection', 'clipboard', '-o'], stdin: undefined })

    const written = await bus.dispatch('clipboard.write', { text: '待粘贴文本' }) as { done: boolean; length: number }
    expect(written).toEqual({ done: true, length: 5 })
    expect(calls[1].cmd).toBe('xclip')
    expect(calls[1].args).toEqual(['-selection', 'clipboard', '-i'])
    expect(calls[1].stdin).toBe('待粘贴文本')
  })

  it('screen.snapshot — 兜底截图走注入的采集器；未注入时明确报错', async () => {
    const withShot = new DesktopBus(fakeDeps(fakeRun().run))
    // fakeDeps 未注入 snapshot → 明确的可读错误（而非静默失败）
    await expect(withShot.dispatch('screen.snapshot')).rejects.toThrow('截图能力未启用')

    const inj = new DesktopBus({
      display: ':99',
      run: fakeRun().run,
      snapshot: async () => 'data:image/png;base64,SHOT',
    })
    expect(await inj.dispatch('screen.snapshot')).toEqual({ screenshot: 'data:image/png;base64,SHOT' })

    const failing = new DesktopBus({ display: ':99', run: fakeRun().run, snapshot: async () => null })
    await expect(failing.dispatch('screen.snapshot')).rejects.toThrow('截图失败')
  })

  it('画面采集跟随分辨率 — 尺寸变化时重启 ffmpeg（否则画面被裁切）', async () => {
    let geom = '1280 800'
    let ffmpegAlive = false
    const calls: string[] = []
    const run: RunFn = async (cmd, args) => {
      calls.push(`${cmd} ${args.join(' ')}`)
      if (cmd === 'pgrep') return ffmpegAlive ? '123\n' : ''
      if (cmd === 'pkill') { ffmpegAlive = false; return '' }
      if (cmd === 'xdotool') return geom
      if (cmd === 'bash') { ffmpegAlive = true; return 'OK' }
      return ''
    }
    const cap = new ScreenCapture({ display: ':99', run })

    await cap.ensureStream()
    expect(calls.some((c) => c.includes('-video_size 1280x800'))).toBe(true)
    const startsAfterFirst = calls.filter((c) => c.startsWith('bash ')).length

    // 同一尺寸再次 ensure → 复用现有流，不重启
    await cap.ensureStream()
    expect(calls.filter((c) => c.startsWith('bash ')).length).toBe(startsAfterFirst)

    // 分辨率改变 → 必须杀旧流并以新尺寸重启
    geom = '1920 1080'
    await cap.ensureStream()
    const bashCalls = calls.filter((c) => c.startsWith('bash '))
    expect(bashCalls.length).toBe(startsAfterFirst + 1)
    expect(bashCalls.at(-1)).toContain('-video_size 1920x1080')
    expect(calls.some((c) => c.startsWith('pkill '))).toBe(true)
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

  it('屏幕端点 — 快照/画面流均要求 Bearer 鉴权，快照走注入的采集器', { timeout: 20_000 }, async () => {
    const f = fakeRun()
    const fakeScreen = {
      snapshot: async (): Promise<string | null> => 'data:image/png;base64,AAAA',
      ensureStream: async (): Promise<void> => {},
      upstreamUrl: 'http://127.0.0.1:1/stream', // 无人监听 → 流 503 路径
    }
    const server = createHostServer({
      config: { listen: '127.0.0.1:18123', display: ':99' },
      token: TOKEN,
      deps: { desktopBus: new DesktopBus(fakeDeps(f.run)), screen: fakeScreen as unknown as ScreenCapture },
    })
    await server.start()
    servers.push(server)
    const base = 'http://127.0.0.1:18123'

    const noAuth = await fetch(`${base}/api/screen/snapshot`)
    expect(noAuth.status).toBe(401)
    const noAuthStream = await fetch(`${base}/api/screen/stream`)
    expect(noAuthStream.status).toBe(401)

    const authed = await fetch(`${base}/api/screen/snapshot`, { headers: { Authorization: `Bearer ${TOKEN}` } })
    expect(authed.status).toBe(200)
    const body = (await authed.json()) as { ok: boolean; screenshot?: string }
    expect(body.ok).toBe(true)
    expect(body.screenshot).toContain('data:image/png')

    const deadStream = await fetch(`${base}/api/screen/stream`, { headers: { Authorization: `Bearer ${TOKEN}` } })
    expect(deadStream.status).toBe(503) // 上游无人监听 → 画面流未就绪
  })
})
