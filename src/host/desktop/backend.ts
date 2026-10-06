/**
 * desktop-bus 后端 — xdotool/wmctrl 执行层（阶段 2，headless-first）
 *
 * 所有命令携带 DISPLAY 环境变量执行，参数一律走 execFile 参数数组（不经 shell，
 * 无注入面）。解析与命令构建集中在此，DesktopBus 只做路由与事件。
 * run/launch/appName 均可注入 — 单测用 fake 后端驱动同一套解析逻辑。
 */
import { execFile, spawn } from 'child_process'
import { existsSync, readFileSync } from 'fs'
import type { DesktopWindow } from '../../shared/types/cockpit'

/** 执行一条 X 命令，返回 stdout；stdin 可选（剪贴板写入等需要喂入数据） */
export type RunFn = (cmd: string, args: string[], timeoutMs?: number, stdin?: string) => Promise<string>

/** 默认执行器 — DISPLAY 注入 + 超时保护 + 可选 stdin */
export function makeRunner(display: string): RunFn {
  return (cmd, args, timeoutMs = 5000, stdin) =>
    new Promise((resolve, reject) => {
      const child = execFile(cmd, args, {
        timeout: timeoutMs,
        env: { ...process.env, DISPLAY: display },
        encoding: 'utf-8',
      }, (err, stdout) => {
        if (err) reject(err instanceof Error ? err : new Error(String(err)))
        else resolve(String(stdout))
      })
      if (stdin !== undefined) {
        child.stdin?.end(stdin)
      } else {
        child.stdin?.end()
      }
    })
}

/** 默认应用启动器 — 脱离会话常驻（detached + unref），返回 pid 便于后续窗口关联 */
export function makeLauncher(display: string): (app: string, args: string[]) => { pid?: number } {
  return (app, args) => {
    try {
      const child = spawn(app, args, {
        stdio: 'ignore',
        detached: true,
        env: { ...process.env, DISPLAY: display },
      })
      child.unref()
      return { pid: child.pid }
    } catch {
      return {}
    }
  }
}

/** 进程名 — /proc/<pid>/comm；读不到返回空串（进程可能已退出） */
export function pidComm(pid: number): string {
  try {
    if (!existsSync(`/proc/${pid}/comm`)) return ''
    return readFileSync(`/proc/${pid}/comm`, 'utf-8').trim()
  } catch {
    return ''
  }
}

/**
 * 解析 `wmctrl -lpG` 输出 → 结构化窗口列表。
 * 行格式：`0x03c00007  0 12345 host 52 52 1176 696 title...`
 * （id / desktop / pid / host / x / y / w / h / title）
 */
export function parseWmctrl(output: string): DesktopWindow[] {
  const windows: DesktopWindow[] = []
  for (const line of output.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    // 前 8 列定长，剩余全归标题（标题可含任意空白）
    const cols = trimmed.split(/\s+/)
    if (cols.length < 9) continue
    const id = cols[0]
    const pid = Number(cols[2])
    const x = Number(cols[4])
    const y = Number(cols[5])
    const w = Number(cols[6])
    const h = Number(cols[7])
    if (!/^0x[0-9a-f]+$/i.test(id)) continue
    windows.push({
      id,
      pid: Number.isFinite(pid) ? pid : 0,
      app: '',
      title: cols.slice(8).join(' '),
      x: Number.isFinite(x) ? x : 0,
      y: Number.isFinite(y) ? y : 0,
      w: Number.isFinite(w) ? w : 0,
      h: Number.isFinite(h) ? h : 0,
    })
  }
  return windows
}

// ---------- 命令构建（集中在此，bus 不拼命令字符串） ----------

export const CMD = {
  listWindows: (): { cmd: string; args: string[] } => ({ cmd: 'wmctrl', args: ['-lpG'] }),
  activate: (id: string): { cmd: string; args: string[] } => ({ cmd: 'wmctrl', args: ['-i', '-a', id] }),
  close: (id: string): { cmd: string; args: string[] } => ({ cmd: 'wmctrl', args: ['-i', '-c', id] }),
  minimize: (id: string): { cmd: string; args: string[] } => ({ cmd: 'wmctrl', args: ['-i', '-r', id, '-b', 'add,hidden'] }),
  restore: (id: string): { cmd: string; args: string[] } => ({ cmd: 'wmctrl', args: ['-i', '-r', id, '-b', 'remove,hidden'] }),
  maximize: (id: string): { cmd: string; args: string[] } =>
    ({ cmd: 'wmctrl', args: ['-i', '-r', id, '-b', 'add,maximized_vert,maximized_horz'] }),
  /** gravity=0；-1 表示保持不变 */
  moveResize: (id: string, x: number, y: number, w: number, h: number): { cmd: string; args: string[] } =>
    ({ cmd: 'wmctrl', args: ['-i', '-r', id, '-e', `0,${x},${y},${w},${h}`] }),
  key: (keys: string): { cmd: string; args: string[] } => ({ cmd: 'xdotool', args: ['key', '--clearmodifiers', keys] }),
  /** 文本作为单个 execFile 参数 — 天然免疫空格/引号注入 */
  type: (text: string): { cmd: string; args: string[] } => ({ cmd: 'xdotool', args: ['type', '--delay', '15', '--', text] }),
  activeId: (): { cmd: string; args: string[] } => ({ cmd: 'xdotool', args: ['getactivewindow'] }),
  // 键鼠注入 — 全部经 execFile 参数数组，坐标为数字强转
  mouseMove: (x: number, y: number): { cmd: string; args: string[] } => ({ cmd: 'xdotool', args: ['mousemove', String(x), String(y)] }),
  /** button: 1=左 2=中 3=右（xdotool 编码） */
  mouseClick: (x: number, y: number, button: number): { cmd: string; args: string[] } =>
    ({ cmd: 'xdotool', args: ['mousemove', String(x), String(y), 'click', String(button)] }),
  /** 滚轮键位：4=上 5=下 6=左 7=右 */
  mouseScroll: (x: number, y: number, amount: number, button: number): { cmd: string; args: string[] } =>
    ({ cmd: 'xdotool', args: ['mousemove', String(x), String(y), 'click', '--repeat', String(amount), String(button)] }),
  displayGeometry: (): { cmd: string; args: string[] } => ({ cmd: 'xdotool', args: ['getdisplaygeometry'] }),
  // 剪贴板 — 读 GUI 应用内容的最快通路（比截图快且准，无需视觉模型）
  clipboardRead: (): { cmd: string; args: string[] } => ({ cmd: 'xclip', args: ['-selection', 'clipboard', '-o'] }),
  clipboardWrite: (text: string): { cmd: string; args: string[] } => ({ cmd: 'xclip', args: ['-selection', 'clipboard', '-i'] }),
} as const

/** xdotool 鼠标按键编码 — 'left'|'middle'|'right' → 1|2|3；滚轮方向 → 4/5/6/7 */
export function mouseButtonCode(button: string): number {
  switch (button) {
    case 'middle': return 2
    case 'right': return 3
    default: return 1
  }
}

export function scrollButtonCode(direction: string): number {
  switch (direction) {
    case 'up': return 4
    case 'down': return 5
    case 'left': return 6
    default: return 7
  }
}
