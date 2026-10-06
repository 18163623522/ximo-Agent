/**
 * 集成测试 — HostClient（驾驶舱侧 cockpit-link 客户端）↔ 真 agent-hostd
 *
 * 与 tests/host/host.test.ts 互补：那份从"裸 WS 客户端"视角验证主机契约，
 * 这份从"驾驶舱"视角验证主进程客户端的完整链路 —— 连接/派任务/流式转录/
 * 审批回路/取消/REST 合并。LLM 用全局 fetch stub（按 URL 区分：llm.local 走
 * SSE 回放，本机 REST 穿透到真实 fetch）。
 */
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'
import { tmpdir } from 'os'
import { join } from 'path'
import { mkdirSync } from 'fs'
import { createHostServer, HostServer } from '../../src/host/server'
import { HostClient, wsUrl, restUrl } from '../../src/main/host/HostClient'
import type { HostStatusInfo, HostMsg, HostTaskRecord } from '../../src/shared/types'

// ---------- electron mock（先于一切导入生效，供 host 侧 task-runner/store 使用） ----------

const TEST_ROOT = join(tmpdir(), `ximo-cabin-test-${Date.now()}`)
const m = vi.hoisted(() => ({ userData: '' }))
beforeAll(() => {
  m.userData = join(TEST_ROOT, 'app')
  mkdirSync(m.userData, { recursive: true })
  process.env.XIMO_HOST_DIR = join(TEST_ROOT, 'config')
  process.env.XIMO_HOST_DATA = join(TEST_ROOT, 'data')
  mkdirSync(process.env.XIMO_HOST_DIR, { recursive: true })
})

const noop = (): void => {}
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
  dialog: {
    showOpenDialog: async (): Promise<{ canceled: boolean }> => ({ canceled: true }),
    showSaveDialog: async (): Promise<{ canceled: boolean }> => ({ canceled: true }),
    showMessageBox: async (): Promise<{ response: number }> => ({ response: 1 }),
  },
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

// ---------- LLM fetch stub（URL 感知：llm.local 走 SSE 回放，本机 REST 穿透） ----------

function sse(frames: unknown[]): Response {
  const encoder = new TextEncoder()
  const stream = new ReadableStream({
    start(c) {
      for (const f of frames) c.enqueue(encoder.encode(`data: ${JSON.stringify(f)}\n\n`))
      c.enqueue(encoder.encode('data: [DONE]\n\n'))
      c.close()
    },
  })
  return new Response(stream, { status: 200 })
}

const textFrames = (text: string) => [
  { choices: [{ delta: { content: text } }] },
  { choices: [{ delta: {}, finish_reason: 'stop' }] },
]
const toolFrames = (id: string, name: string, args: string) => [
  { choices: [{ delta: { tool_calls: [{ index: 0, id, function: { name, arguments: args } }] } }] },
  { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
]

/** 真 fetch 快照 — 多个用例连续 stub 时穿透 REST 必须用它，否则 stub 链式递归爆栈 */
const REAL_FETCH = globalThis.fetch.bind(globalThis)

function stubLlm(rounds: unknown[][]): void {
  let i = 0
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    if (!url.includes('llm.local')) return REAL_FETCH(input, init)
    const frames = rounds[Math.min(i, rounds.length - 1)]
    i++
    return sse(frames)
  }))
}

/** 永不完成但响应 abort 的 fetch — 取消测试用 */
function stubHangingLlm(): void {
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    if (!url.includes('llm.local')) return REAL_FETCH(input, init)
    return new Promise<Response>((_resolve, rejectPromise) => {
      init?.signal?.addEventListener('abort', () => {
        const e = new Error('This operation was aborted')
        e.name = 'AbortError'
        rejectPromise(e)
      })
    })
  }))
}

// ---------- HostClient 测试驱动 ----------

const TOKEN = 'cabin-test-token'

function makeCollector() {
  const statuses: HostStatusInfo[] = []
  const events: HostMsg[] = []
  const taskSnapshots: HostTaskRecord[][] = []
  const emit = {
    status: (s: HostStatusInfo): void => { statuses.push(s) },
    tasks: (t: HostTaskRecord[]): void => { taskSnapshots.push(t) },
    event: (msg: HostMsg): void => { events.push(msg) },
  }
  const waitStatus = (pred: (s: HostStatusInfo) => boolean, timeoutMs = 10_000): Promise<HostStatusInfo> =>
    new Promise((resolve, reject) => {
      const timer = setInterval(() => {
        const found = [...statuses].reverse().find(pred)
        if (found) { clearInterval(timer); resolve(found) }
      }, 15)
      setTimeout(() => {
        clearInterval(timer)
        reject(new Error('等待状态超时: ' + JSON.stringify(statuses.slice(-3))))
      }, timeoutMs)
    })
  const waitEvent = (pred: (m: HostMsg) => boolean, timeoutMs = 15_000): Promise<HostMsg> =>
    new Promise((resolve, reject) => {
      const timer = setInterval(() => {
        const found = [...events].reverse().find(pred)
        if (found) { clearInterval(timer); resolve(found) }
      }, 15)
      setTimeout(() => {
        clearInterval(timer)
        reject(new Error('等待事件超时: ' + JSON.stringify(events.slice(-4))))
      }, timeoutMs)
    })
  return { statuses, events, taskSnapshots, emit, waitStatus, waitEvent }
}

const servers: HostServer[] = []
const clients: HostClient[] = []
afterAll(async () => {
  for (const c of clients) c.dispose()
  for (const s of servers) await s.close()
  vi.unstubAllGlobals()
})

async function makeServer(port: number, approvalTimeoutMs = 8_000): Promise<HostServer> {
  const host = createHostServer({
    config: { listen: `127.0.0.1:${port}`, apiKey: 'test-key', baseUrl: 'http://llm.local/v1', model: 'test-model', mode: 'coding', approvalTimeoutMs },
    token: TOKEN,
    deps: { approvalTimeoutMs },
  })
  await host.start()
  servers.push(host)
  return host
}

function makeClient(emit: ReturnType<typeof makeCollector>['emit'], port: number): HostClient {
  const c = new HostClient(emit)
  clients.push(c)
  c.connect(`http://127.0.0.1:${port}`, TOKEN)
  return c
}

const lastSnapshotFor = (snaps: HostTaskRecord[][], id: string): HostTaskRecord | undefined => {
  for (const s of [...snaps].reverse()) {
    const found = s.find(t => t.id === id)
    if (found) return found
  }
  return undefined
}

// ---------- 用例 ----------

describe('HostClient — URL 归一化', () => {
  it('http → ws + /ws 路径', () => {
    expect(wsUrl('http://127.0.0.1:17890')).toBe('ws://127.0.0.1:17890/ws')
    expect(wsUrl('http://127.0.0.1:17890/')).toBe('ws://127.0.0.1:17890/ws')
  })
  it('https → wss', () => {
    expect(wsUrl('https://host.example:17890')).toBe('wss://host.example:17890/ws')
  })
  it('ws 输入保留协议', () => {
    expect(wsUrl('ws://host.example:17890')).toBe('ws://host.example:17890/ws')
    expect(wsUrl('wss://host.example:17890/ws')).toBe('wss://host.example:17890/ws')
  })
  it('restUrl 把 ws 输入归一化为 http', () => {
    expect(restUrl('ws://127.0.0.1:17890', '/api/health')).toBe('http://127.0.0.1:17890/api/health')
    expect(restUrl('https://host.example', '/api/tasks')).toBe('https://host.example/api/tasks')
  })
})

describe('HostClient ↔ agent-hostd（真服务端）', () => {
  it('未连接时 dispatch 直接失败（不悬挂）', async () => {
    const c = new HostClient({ status: noop, tasks: noop, event: noop })
    clients.push(c)
    const res = await c.dispatch('任意任务')
    expect(res.ok).toBe(false)
    expect(res.error).toBeTruthy()
  })

  it('connect → hello → connected，health 探测返回主机信息', { timeout: 20_000 }, async () => {
    stubLlm([textFrames('ok')])
    await makeServer(18101)
    const col = makeCollector()
    const c = makeClient(col.emit, 18101)

    const st = await col.waitStatus(s => s.status === 'connected')
    expect(st.url).toBe('http://127.0.0.1:18101')
    const hello = await col.waitEvent(m => m.t === 'hello')
    expect(hello.name).toBe('ximo-host')

    const h = await c.health()
    expect(h.ok).toBe(true)
    expect(h.name).toBe('ximo-host')
    c.disconnect()
    expect(c.getStatus().status).toBe('disconnected')
  })

  it('health 探测：错误令牌 → 401 归因', { timeout: 20_000 }, async () => {
    await makeServer(18102)
    const col = makeCollector()
    const probe = new HostClient({ status: noop, tasks: noop, event: noop })
    clients.push(probe)
    probe.connect('http://127.0.0.1:18102', 'wrong-token')
    await col.waitStatus(s => s.status === 'error' || s.status === 'connected', 10_000).catch(() => {})
    const h = await probe.health()
    expect(h.ok).toBe(false)
    expect(h.error).toContain('401')
  })

  it('dispatch → accepted → chunk(text) → done(completed)，任务快照累积转录', { timeout: 30_000 }, async () => {
    stubLlm([textFrames('主机回答完成')])
    await makeServer(18103)
    const col = makeCollector()
    const c = makeClient(col.emit, 18103)
    await col.waitStatus(s => s.status === 'connected')

    const res = await c.dispatch('在工作区创建 hello.txt', 'coding')
    expect(res.ok).toBe(true)
    expect(res.id).toBeTruthy()

    await col.waitEvent(m => m.t === 'task.accepted' && m.id === res.id)
    const done = await col.waitEvent(m => m.t === 'task.done' && m.id === res.id, 25_000)
    expect(done.status).toBe('completed')
    expect(done.result).toContain('主机回答完成')

    const rec = lastSnapshotFor(col.taskSnapshots, res.id!)
    expect(rec?.chunks.some(ch => ch.type === 'text' && ch.text.includes('主机回答完成'))).toBe(true)
    expect(rec?.status).toBe('completed')
  })

  it('ask 类工具 → approval.request → respond(allow) → 工具真实执行', { timeout: 40_000 }, async () => {
    stubLlm([
      toolFrames('c1', 'terminal_exec', JSON.stringify({ command: 'echo approval-ok' })),
      textFrames('done'),
    ])
    await makeServer(18104, 3_000)
    const col = makeCollector()
    const c = makeClient(col.emit, 18104)
    await col.waitStatus(s => s.status === 'connected')

    const res = await c.dispatch('跑一条命令')
    const approval = await col.waitEvent(m => m.t === 'approval.request' && m.id === res.id, 25_000)
    expect(approval.tool).toBe('terminal_exec')
    expect(approval.summary).toContain('approval-ok')

    await col.waitEvent(m => m.t === 'task.status' && m.id === res.id && m.stage === 'awaiting_approval')
    // 任务行状态应显示等待审批
    expect(lastSnapshotFor(col.taskSnapshots, res.id!)?.status).toBe('awaiting_approval')

    c.respondApproval(approval.reqId, true)
    const done = await col.waitEvent(m => m.t === 'task.done' && m.id === res.id, 30_000)
    expect(done.status).toBe('completed')

    const rec = lastSnapshotFor(col.taskSnapshots, res.id!)
    const toolResult = rec?.chunks.find(ch => ch.type === 'tool_result')
    expect(toolResult && toolResult.success).toBe(true)
    if (toolResult && toolResult.type === 'tool_result') {
      expect(toolResult.content).toContain('approval-ok')
    }
  })

  it('审批拒绝 → 工具收到拒绝并继续运行到完成', { timeout: 40_000 }, async () => {
    stubLlm([
      toolFrames('c1', 'terminal_exec', JSON.stringify({ command: 'echo denied-run' })),
      textFrames('已跳过命令'),
    ])
    await makeServer(18105, 3_000)
    const col = makeCollector()
    const c = makeClient(col.emit, 18105)
    await col.waitStatus(s => s.status === 'connected')

    const res = await c.dispatch('拒绝路径')
    const approval = await col.waitEvent(m => m.t === 'approval.request' && m.id === res.id, 25_000)
    c.respondApproval(approval.reqId, false)
    const done = await col.waitEvent(m => m.t === 'task.done' && m.id === res.id, 30_000)
    expect(done.status).toBe('completed')

    const rec = lastSnapshotFor(col.taskSnapshots, res.id!)
    const toolResult = rec?.chunks.find(ch => ch.type === 'tool_result')
    expect(toolResult && toolResult.success).toBe(false)
  })

  it('cancel → done(cancelled)', { timeout: 30_000 }, async () => {
    stubHangingLlm()
    await makeServer(18106)
    const col = makeCollector()
    const c = makeClient(col.emit, 18106)
    await col.waitStatus(s => s.status === 'connected')

    const res = await c.dispatch('长任务')
    await col.waitEvent(m => m.t === 'task.accepted' && m.id === res.id)
    c.cancel(res.id!)
    const done = await col.waitEvent(m => m.t === 'task.done' && m.id === res.id, 25_000)
    expect(done.status).toBe('cancelled')
  })

  it('REST listTasks 与本地实时视图合并', { timeout: 30_000 }, async () => {
    stubLlm([textFrames('历史任务')])
    await makeServer(18107)
    const col = makeCollector()
    const c = makeClient(col.emit, 18107)
    await col.waitStatus(s => s.status === 'connected')

    const res = await c.dispatch('历史查询任务')
    await col.waitEvent(m => m.t === 'task.done' && m.id === res.id, 25_000)

    const tasks = await c.listTasks()
    const rec = tasks.find(t => t.id === res.id)
    expect(rec).toBeTruthy()
    expect(rec?.status).toBe('completed')
    expect(rec?.chunks.length).toBeGreaterThan(0)
  })
})
