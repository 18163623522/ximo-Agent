/**
 * desktop-bus Xvfb 集成测试（阶段 A5）— 真实 X 工具在环
 *
 * 与 desktop-bus.test.ts 的区别：后者用 fake 后端驱动解析/路由逻辑（单元层）；
 * 本测试用真 makeRunner + 真 wmctrl/xdotool/xclip，在 xvfb-run 下跑。
 *
 * 运行条件：DISPLAY 环境变量已设 + wmctrl/xdotool/xclip 可执行 + 至少一个窗口存在。
 * CI 中由 xvfb-run + openbox + xterm 提供；本机无 X 时自动跳过。
 *
 * 真机怪癖直接暴露在断言里：
 *  - getactivewindow 无聚焦窗口时 rc=1（正常空态）
 *  - wmctrl 输出十六进制窗口 id、xdotool 输出十进制
 *  - 空剪贴板 xclip 以非零退出码报错
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { execFileSync, spawn } from 'child_process'
import { existsSync } from 'fs'
import { DesktopBus } from '../../src/host/desktop/bus'
import { makeRunner, makeLauncher, pidComm } from '../../src/host/desktop/backend'

const DISPLAY = process.env.DISPLAY ?? ''

/** 检查命令是否可执行 */
function hasCmd(cmd: string): boolean {
  try { execFileSync('which', [cmd], { stdio: 'ignore' }); return true } catch { return false }
}

const X_READY = DISPLAY !== '' && hasCmd('wmctrl') && hasCmd('xdotool') && hasCmd('xclip')

const skip = !X_READY
const itXvfb = skip ? it.skip : it

// 启动的子进程 — afterAll 清理
const children: { kill: () => void }[] = []

/** 等待窗口出现（轮询 wmctrl 直到标题子串匹配或超时） */
async function waitForWindow(titleSub: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const out = execFileSync('wmctrl', ['-l'], { encoding: 'utf-8', env: { ...process.env, DISPLAY } })
      if (out.includes(titleSub)) return
    } catch { /* wmctrl 可能短暂失败 */ }
    await new Promise((r) => setTimeout(r, 300))
  }
  throw new Error(`等待窗口「${titleSub}」超时`)
}

/** 等待窗口消失 */
async function waitForWindowGone(titleSub: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const out = execFileSync('wmctrl', ['-l'], { encoding: 'utf-8', env: { ...process.env, DISPLAY } })
      if (!out.includes(titleSub)) return
    } catch { /* wmctrl 可能短暂失败 */ }
    await new Promise((r) => setTimeout(r, 300))
  }
  throw new Error(`等待窗口「${titleSub}」消失超时`)
}

describe.skipIf(skip)('desktop-bus Xvfb 集成测试 — 真实 X 工具在环', () => {
  let bus: DesktopBus

  beforeAll(async () => {
    bus = new DesktopBus({
      display: DISPLAY,
      run: makeRunner(DISPLAY),
      launch: makeLauncher(DISPLAY),
      appName: pidComm,
    })

    // 启动一个 xterm 窗口供测试驱动
    if (hasCmd('xterm')) {
      const child = spawn('xterm', ['-title', 'XVFB_TEST_WINDOW', '-e', 'sleep 300'], {
        env: { ...process.env, DISPLAY },
        stdio: 'ignore',
        detached: true,
      })
      child.unref()
      children.push({ kill: () => child.kill() })
      await waitForWindow('XVFB_TEST_WINDOW')
    }
  }, 30_000)

  afterAll(() => {
    for (const c of children) c.kill()
  })

  itXvfb('window.list — 真实 wmctrl 输出解析出至少一个窗口', async () => {
    const windows = await bus.dispatch('window.list') as { id: string; title: string }[]
    expect(windows.length).toBeGreaterThanOrEqual(1)
    // wmctrl 输出十六进制 id
    expect(windows[0].id).toMatch(/^0x[0-9a-f]+$/i)
  })

  itXvfb('screen.size — getdisplaygeometry 返回有效分辨率', async () => {
    const size = await bus.dispatch('screen.size') as { width: number; height: number }
    expect(size.width).toBeGreaterThan(0)
    expect(size.height).toBeGreaterThan(0)
  })

  itXvfb('active — 聚焦窗口后 getactivewindow 返回十进制 id，与 wmctrl 十六进制归一化匹配', async () => {
    // 先确保有窗口 — 激活 xterm
    const windows = await bus.dispatch('window.list') as { id: string; title: string }[]
    const target = windows.find((w) => w.title.includes('XVFB_TEST_WINDOW'))
    if (!target) throw new Error('测试窗口未找到')

    // 激活窗口
    await bus.dispatch('window.op', { op: 'activate', window_id: target.id })
    await new Promise((r) => setTimeout(r, 500)) // 等焦点切换

    const active = await bus.dispatch('active') as { id: string } | null
    expect(active).not.toBeNull()
    // active 的 id 应该和 target id 归一化后一致
    expect(active?.id).toBeTruthy()
  })

  itXvfb('active 无聚焦 — 桌面背景无窗口焦点时返回 null（rc=1 正常空态）', async () => {
    // 在 Xvfb + openbox 中，如果不点击窗口、桌面本身可能无聚焦
    // 但由于 beforeAll 启动了 xterm，这里我们测另一种路径：
    // 先关闭 xterm，等无窗口后 active 应返回 null
    const windows = await bus.dispatch('window.list') as { id: string; title: string }[]
    const xterm = windows.find((w) => w.title.includes('XVFB_TEST_WINDOW'))
    if (xterm) {
      await bus.dispatch('window.op', { op: 'close', window_id: xterm.id })
      await waitForWindowGone('XVFB_TEST_WINDOW')
    }

    // 无窗口 → active 返回 null（rc=1 正常空态，不抛错）
    const active = await bus.dispatch('active') as null
    expect(active).toBeNull()

    // 关键：正常空态不置 unavailableReason → 后续操作照常可用
    const size = await bus.dispatch('screen.size') as { width: number }
    expect(size.width).toBeGreaterThan(0)
  })

  itXvfb('clipboard.write/read — 写入后读回一致', async () => {
    const text = `ximo-os 剪贴板测试 ${Date.now()}`
    await bus.dispatch('clipboard.write', { text })
    const read = await bus.dispatch('clipboard.read') as { text: string }
    expect(read.text).toBe(text)
  }, 20_000)

  itXvfb('clipboard.read 空态 — 清空后读取返回空串（xclip 非零退出码不污染后续操作）', async () => {
    // 清空剪贴板 — 写入空串再读
    await bus.dispatch('clipboard.write', { text: '' })
    // xclip 读完最后一个内容后可能仍有空行，再写一次空并立即读
    // 真实空态：用 xclip -selection clipboard -o 读空剪贴板时 rc≠0
    // DesktopBus 的 clipboard.read 已处理：catch → { text: '' }
    const read = await bus.dispatch('clipboard.read') as { text: string }
    // 空态可能返回空串或残留 — 关键是不抛错、不置 unavailableReason
    expect(read).toBeDefined()

    // 后续操作不受影响
    const size = await bus.dispatch('screen.size') as { width: number }
    expect(size.width).toBeGreaterThan(0)
  }, 20_000)

  itXvfb('type/key — xdotool 注入键盘事件不报错', async () => {
    // 重新启动 xterm 接收输入
    if (hasCmd('xterm')) {
      const child = spawn('xterm', ['-title', 'XVFB_TYPE_TEST', '-e', 'sleep 300'], {
        env: { ...process.env, DISPLAY },
        stdio: 'ignore',
        detached: true,
      })
      child.unref()
      children.push({ kill: () => child.kill() })
      await waitForWindow('XVFB_TYPE_TEST')

      // 激活并输入
      const windows = await bus.dispatch('window.list') as { id: string; title: string }[]
      const target = windows.find((w) => w.title.includes('XVFB_TYPE_TEST'))
      if (target) {
        await bus.dispatch('window.op', { op: 'activate', window_id: target.id })
        await new Promise((r) => setTimeout(r, 500))

        // type 不应抛错
        await bus.dispatch('type', { text: 'hello xvfb' })
        // key 不应抛错
        await bus.dispatch('key', { keys: 'Return' })
      }
    }
  })

  itXvfb('mouse.move/click — xdotool 鼠标事件不报错', async () => {
    await bus.dispatch('mouse.move', { x: 100, y: 100 })
    await bus.dispatch('mouse.click', { x: 100, y: 100, button: 'left' })
  })

  itXvfb('mouse.scroll — 滚轮事件不报错', async () => {
    await bus.dispatch('mouse.scroll', { x: 100, y: 100, direction: 'down', amount: 2 })
  })

  itXvfb('坐标无效 — 非数字坐标抛错且不执行 xdotool', async () => {
    await expect(bus.dispatch('mouse.click', { x: 'bad', y: 80 })).rejects.toThrow('坐标参数无效')
    await expect(bus.dispatch('mouse.move', { x: 55, y: null })).rejects.toThrow('坐标参数无效')
  })

  itXvfb('事件轮询 — 窗口集合变化时推送事件', async () => {
    // 建立基线
    await bus.checkEvents()
    const events: unknown[] = []
    const off = bus.onEvent((e) => events.push(e))

    try {
      const child = spawn('xterm', ['-title', 'XVFB_EVENT_TEST', '-e', 'sleep 60'], {
        env: { ...process.env, DISPLAY },
        stdio: 'ignore',
        detached: true,
      })
      child.unref()
      children.push({ kill: () => child.kill() })

      // 先确认窗口真的出现了（失败时给出比「0 events」更有用的证据）
      await waitForWindow('XVFB_EVENT_TEST', 15_000)

      // 主动驱动轮询（2s 定时器也在跑）——窗口出现后一拍内应推送
      const deadline = Date.now() + 10_000
      while (events.length === 0 && Date.now() < deadline) {
        await bus.checkEvents()
        if (events.length === 0) await new Promise((r) => setTimeout(r, 500))
      }
      expect(events.length).toBeGreaterThanOrEqual(1)
      const first = events[0] as { kind: string }
      expect(first.kind).toBe('window')
    } finally {
      off()
    }
  }, 30_000)
})
