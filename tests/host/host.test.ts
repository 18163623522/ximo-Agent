/**
 * 集成测试 — agent-hostd（ximo-OS 阶段 0.5，真 agent-loop + 真实工具域）
 *
 * 服务端真起 HTTP+WS；LLM 用全局 fetch stub（OpenAI 兼容 SSE）；工具走
 * 主应用真实实现（TerminalExecTool / FileWriteTool / WebFetchTool），
 * 权限审批经 checkPermissions → requestConfirmation → cockpit-link。
 * electron 以 vi.mock 替身提供（app.getPath 指向测试临时目录）。
 *
 * 注意：collector 必须在 WebSocket 构造时挂 message 监听 — 服务端 hello 与
 * 101 握手同段到达，open 之后才挂监听会永久丢帧。
 */
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'
import { tmpdir } from 'os'
import { join } from 'path'
import { mkdirSync, existsSync } from 'fs'
import WebSocket from 'ws'
import { createHostServer, HostServer } from '../../src/host/server'
import { HOST_VERSION } from '../../src/shared/types/cockpit'

// ---------- electron mock（先于一切导入生效） ----------

const TEST_ROOT = join(tmpdir(), `ximo-host-test-${Date.now()}`)
const m = vi.hoisted(() => ({
  userData: '',
}))
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
  clipboard: { readText: (): string => '', writeText: noop },
  shell: { openExternal: async (): Promise<boolean> => true, openPath: async (): Promise<string> => '', showItemInFolder: noop },
  net: { fetch: (...a: unknown[]) => fetch(...(a as [Parameters<typeof fetch>[0]])), isOnline: (): boolean => true },
  protocol: { handle: noop },
  screen: { getPrimaryDisplay: () => ({ size: { width: 1920, height: 1080 } }), on: noop },
  nativeTheme: { on: noop, shouldUseDarkColors: true },
  systemPreferences: { on: noop, getUserDefault: (): undefined => undefined },
  powerMonitor: { on: noop },
  session: { defaultSession: {} },
  safeStorage: { isEncryptionAvailable: (): boolean => false },
  }
})

const TOKEN = 'test-token-123'

// ---------- LLM 全局 fetch stub ----------

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

/** 按调用顺序回放 SSE 响应的全局 fetch stub */
function stubLlm(rounds: unknown[][]): void {
  let i = 0
  vi.stubGlobal('fetch', vi.fn(async () => {
    const frames = rounds[Math.min(i, rounds.length - 1)]
    i++
    return sse(frames)
  }))
}

/** 永不完成但响应 abort 的 fetch — 取消测试用 */
function stubHangingLlm(): void {
  vi.stubGlobal('fetch', vi.fn((_url: string | URL, init?: RequestInit) =>
    new Promise<Response>((_resolve, rejectPromise) => {
      init?.signal?.addEventListener('abort', () => {
        const e = new Error('This operation was aborted')
        e.name = 'AbortError'
        rejectPromise(e)
      })
    })
  ))
}

// ---------- WS 客户端 ----------

interface Msg { t: string; [k: string]: unknown }

interface Conn {
  ws: WebSocket
  seen: Msg[]
  wait: (pred: (m: Msg) => boolean, timeoutMs?: number) => Promise<Msg>
  opened: Promise<void>
  close: () => void
}

function connect(port: number, token = TOKEN): Conn {
  const seen: Msg[] = []
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${token}`)
  ws.on('message', (raw) => { seen.push(JSON.parse(String(raw)) as Msg) })
  const wait = (pred: (m: Msg) => boolean, timeoutMs = 15_000): Promise<Msg> =>
    new Promise((resolvePromise, rejectPromise) => {
      const timer = setInterval(() => {
        const found = [...seen].reverse().find(pred)
        if (found) { clearInterval(timer); resolvePromise(found) }
      }, 15)
      setTimeout(() => {
        clearInterval(timer)
        rejectPromise(new Error('等待消息超时: ' + JSON.stringify(seen.slice(-4))))
      }, timeoutMs)
    })
  return {
    ws, seen, wait,
    opened: new Promise((resolvePromise, rejectPromise) => {
      ws.on('open', () => resolvePromise())
      ws.on('error', rejectPromise)
    }),
    close: () => ws.close(),
  }
}

const hosts: HostServer[] = []
afterAll(async () => {
  for (const h of hosts) await h.close()
  vi.unstubAllGlobals()
})

function makeServer(port: number, opts?: { approvalTimeoutMs?: number }): HostServer {
  const host = createHostServer({
    config: { listen: `127.0.0.1:${port}`, apiKey: 'test-key', baseUrl: 'http://llm.local/v1', model: 'test-model', mode: 'coding', approvalTimeoutMs: opts?.approvalTimeoutMs ?? 8_000 },
    token: TOKEN,
    deps: { approvalTimeoutMs: opts?.approvalTimeoutMs },
  })
  hosts.push(host)
  return host
}

async function restHealth(port: number, auth = true): Promise<{ status: number }> {
  const res = await fetch(`http://127.0.0.1:${port}/api/health`, {
    headers: auth ? { Authorization: `Bearer ${TOKEN}` } : {},
  })
  return { status: res.status }
}

// ---------- 用例 ----------

describe('agent-hostd — cockpit-link 契约（真 agent-loop）', () => {
  it('REST 鉴权：无令牌 401，有令牌返回健康信息', async () => {
    const host = makeServer(18021)
    await host.start()
    expect((await restHealth(18021, false)).status).toBe(401)
    expect((await restHealth(18021)).status).toBe(200)
  })

  it('WS 鉴权：错误令牌被拒；正确令牌收到 hello', async () => {
    const host = makeServer(18022)
    await host.start()
    await expect(connect(18022, 'wrong').opened).rejects.toThrow()
    const c = connect(18022)
    await c.opened
    const hello = await c.wait(m => m.t === 'hello')
    // 版本跟随契约常量（新增 desktop.* 消息 → v1）；server 必须与 shared 声明一致
    expect(hello.version).toBe(HOST_VERSION)
    c.close()
  })

  it('纯文本任务全链路：dispatch → accepted → chunk(text) → done(completed)', async () => {
    stubLlm([textFrames('你好，已完成')]) // 任务短于 30 字符 → 跳过规划轮
    const host = makeServer(18023)
    await host.start()
    const c = connect(18023)
    await c.opened
    await c.wait(m => m.t === 'hello')
    c.ws.send(JSON.stringify({ t: 'task.dispatch', id: 't1', task: '打招呼' }))
    await c.wait(m => m.t === 'task.accepted' && m.id === 't1')
    const chunk = await c.wait(m => m.t === 'task.chunk' && m.id === 't1')
    expect((chunk.delta as { type: string; text: string }).text).toBe('你好，已完成')
    const done = await c.wait(m => m.t === 'task.done' && m.id === 't1')
    expect(done.status).toBe('completed')
    expect(done.result).toBe('你好，已完成')
    expect(existsSync(join(process.env.XIMO_HOST_DATA!, 'tasks', 't1.json'))).toBe(true)
  })

  it('审批回路-允许：terminal_exec 需审批 → 批准后真实执行（主应用 TerminalExecTool）', async () => {
    stubLlm([
      toolFrames('c1', 'terminal_exec', JSON.stringify({ command: 'echo hi' })),
      textFrames('命令已执行'),
    ])
    const host = makeServer(18024)
    await host.start()
    const c = connect(18024)
    await c.opened
    await c.wait(m => m.t === 'hello')
    c.ws.send(JSON.stringify({ t: 'task.dispatch', id: 't2', task: '跑个命令' }))

    const req = await c.wait(m => m.t === 'approval.request' && m.tool === 'terminal_exec')
    expect(String(req.summary)).toContain('command')
    c.ws.send(JSON.stringify({ t: 'approval.respond', reqId: req.reqId, allow: true }))

    const tr = await c.wait(m => m.t === 'task.chunk' && (m.delta as { type: string }).type === 'tool_result')
    expect((tr.delta as { success: boolean }).success).toBe(true)
    expect((tr.delta as { content: string }).content).toContain('hi')
    const done = await c.wait(m => m.t === 'task.done' && m.id === 't2')
    expect(done.status).toBe('completed')
  })

  it('审批回路-拒绝：用户拒绝 → 工具不执行，拒绝信息回给 LLM 正常收尾', async () => {
    stubLlm([
      toolFrames('c1', 'terminal_exec', JSON.stringify({ command: 'rm -rf /' })),
      textFrames('好的，不删了'),
    ])
    const host = makeServer(18025)
    await host.start()
    const c = connect(18025)
    await c.opened
    await c.wait(m => m.t === 'hello')
    c.ws.send(JSON.stringify({ t: 'task.dispatch', id: 't3', task: '删库' }))
    const req = await c.wait(m => m.t === 'approval.request')
    c.ws.send(JSON.stringify({ t: 'approval.respond', reqId: req.reqId, allow: false }))
    const tr = await c.wait(m => m.t === 'task.chunk' && (m.delta as { type: string }).type === 'tool_result')
    expect((tr.delta as { success: boolean }).success).toBe(false)
    const done = await c.wait(m => m.t === 'task.done' && m.id === 't3')
    expect(done.status).toBe('completed')
  })

  it('审批超时 fail-closed：无人响应 → 视为拒绝', async () => {
    stubLlm([
      toolFrames('c1', 'terminal_exec', JSON.stringify({ command: 'echo hi' })),
      textFrames('ok'),
    ])
    const host = makeServer(18026, { approvalTimeoutMs: 100 })
    await host.start()
    const c = connect(18026)
    await c.opened
    await c.wait(m => m.t === 'hello')
    c.ws.send(JSON.stringify({ t: 'task.dispatch', id: 't4', task: 'x' }))
    await c.wait(m => m.t === 'approval.request')
    const tr = await c.wait(m => m.t === 'task.chunk' && (m.delta as { type: string }).type === 'tool_result', 8_000)
    expect((tr.delta as { success: boolean }).success).toBe(false)
  })

  it('写白名单：file_write 逃逸工作区被 security-guard 拦截；工作区内写入成功', async () => {
    stubLlm([
      toolFrames('c1', 'file_write', JSON.stringify({ filePath: '../../evil.txt', content: 'x' })),
      toolFrames('c2', 'file_write', JSON.stringify({ filePath: 'out.txt', content: '工作区产物' })),
      textFrames('done'),
    ])
    const host = makeServer(18027)
    await host.start()
    const c = connect(18027)
    await c.opened
    await c.wait(m => m.t === 'hello')
    c.ws.send(JSON.stringify({ t: 'task.dispatch', id: 't5', task: '写文件' }))

    await c.wait(m => m.t === 'task.done' && m.id === 't5')
    const trs = c.seen.filter(x => x.t === 'task.chunk' && (x.delta as { type: string }).type === 'tool_result')
    const contents = trs.map(x => (x.delta as { content: string }).content)
    expect(contents.some(t => t.includes('不在允许写入')), JSON.stringify(contents)).toBe(true)
    expect(trs.some(x => (x.delta as { success: boolean }).success)).toBe(true)
    expect(existsSync(join(process.env.XIMO_HOST_DATA!, 'workspace', 't5', 'out.txt'))).toBe(true)
    expect(existsSync(join(TEST_ROOT, 'evil.txt'))).toBe(false)
  })

  it('SSRF：web_fetch 内网地址被拦截（主应用 security-guard，不发起真实请求）', async () => {
    stubLlm([
      toolFrames('c1', 'web_fetch', JSON.stringify({ url: 'http://169.254.169.254/latest/meta-data' })),
      textFrames('done'),
    ])
    const host = makeServer(18028)
    await host.start()
    const c = connect(18028)
    await c.opened
    await c.wait(m => m.t === 'hello')
    c.ws.send(JSON.stringify({ t: 'task.dispatch', id: 't6', task: 'x' }))
    const tr = await c.wait(m => m.t === 'task.chunk' && (m.delta as { type: string }).type === 'tool_result')
    expect((tr.delta as { content: string }).content).toContain('SSRF')
  })

  it('取消：dispatch 后 cancel → done(cancelled)', { timeout: 20_000 }, async () => {
    stubHangingLlm()
    const host = makeServer(18029)
    await host.start()
    const c = connect(18029)
    await c.opened
    await c.wait(m => m.t === 'hello')
    c.ws.send(JSON.stringify({ t: 'task.dispatch', id: 't7', task: 'x' }))
    await c.wait(m => m.t === 'task.accepted' && m.id === 't7')
    c.ws.send(JSON.stringify({ t: 'task.cancel', id: 't7' }))
    const done = await c.wait(m => m.t === 'task.done' && m.id === 't7', 18_000)
    expect(done.status).toBe('cancelled')
  })

  it('幂等：同一 id 重复 dispatch → 第二次收到 error(duplicate_id)', async () => {
    stubLlm([textFrames('ok')])
    const host = makeServer(18030)
    await host.start()
    const c = connect(18030)
    await c.opened
    await c.wait(m => m.t === 'hello')
    c.ws.send(JSON.stringify({ t: 'task.dispatch', id: 'dup', task: 'a' }))
    await c.wait(m => m.t === 'task.accepted' && m.id === 'dup')
    c.ws.send(JSON.stringify({ t: 'task.dispatch', id: 'dup', task: 'b' }))
    const err = await c.wait(m => m.t === 'error')
    expect(err.code).toBe('duplicate_id')
  })
})
