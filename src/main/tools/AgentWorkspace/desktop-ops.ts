/**
 * desktop-ops — Agent 桌面的 GUI/命令操作层（无状态）
 *
 * 截图、鼠标/键盘输入、WSL 命令执行、窗口管理、应用启动、分辨率切换、
 * 剪贴板、ffmpeg 画面流的探测与自愈等操作的具体实现。
 * 「工作区是否就绪」的门闩判断由 AgentWorkspaceManager 的对应方法负责，
 * 本模块不持有可变单例状态。
 */

import { execFile } from 'child_process'
import { promisify } from 'util'
import { decodeWslOutput } from './wsl-decode'
import { DISPLAY, WSL_DISTRIBUTION, WSL_STREAM_PORT, execWslDisplay, execWslRaw } from './wsl-exec'
import { WSL_INIT_SCRIPT } from './init-script'

const execFileAsync = promisify(execFile)

/** 截图 — 返回 base64 data URL */
export async function screenshot(): Promise<string | null> {
  try {
    const tmpFile = `/tmp/agent-workspace-screenshot-${Date.now()}.png`
    await execWslDisplay(`import -window root ${tmpFile} 2>/dev/null`)
    const base64 = await execWslRaw(`base64 -w0 ${tmpFile} 2>/dev/null && rm -f ${tmpFile}`)
    const trimmed = base64.trim()
    if (!trimmed) return null
    const dataUrl = `data:image/png;base64,${trimmed}`
    return dataUrl
  } catch {
    return null
  }
}

/** 探测 ffmpeg MJPEG 流是否就绪（最多 ~8s）。
 *  用 pgrep -x 按进程名精确匹配 — pgrep -f 会匹配到检查命令自身的命令行文本（永远误报 ALIVE）；
 *  也不用 TCP 连接探测 — mpjpeg -listen 是单客户端服务，探测连接会占用唯一的 accept 名额。 */
export async function waitForStream(): Promise<boolean> {
  for (let i = 0; i < 16; i++) {
    try {
      const { stdout } = await execFileAsync('wsl.exe', [
        '-d', WSL_DISTRIBUTION, '--exec', 'bash', '-c',
        'pgrep -x ffmpeg >/dev/null && echo ALIVE'
      ], { timeout: 10_000, windowsHide: true, encoding: 'buffer' })
      if (decodeWslOutput(stdout as Buffer) === 'ALIVE') return true
    } catch { /* 重试 */ }
    await new Promise((r) => setTimeout(r, 500))
  }
  console.warn('[AgentWorkspace] ffmpeg 画面流未就绪，面板将回退快照轮询模式')
  return false
}

export async function doEnsureStream(): Promise<void> {
  try {
    const { stdout } = await execFileAsync('wsl.exe', [
      '-d', WSL_DISTRIBUTION, '--exec', 'bash', '-c',
      'pgrep -x ffmpeg >/dev/null && echo ALIVE || echo DEAD'
    ], { timeout: 10_000, windowsHide: true, encoding: 'buffer' })
    if (decodeWslOutput(stdout as Buffer) === 'ALIVE') return
    // 重新拉起 — setsid + 三流重定向（同 init 脚本，防管道占用与会话连带）；sleep 确保返回时已 listen
    await execWslRaw(
      `setsid ffmpeg -f x11grab -framerate 10 -video_size 1280x800 -i ${DISPLAY} -c:v mjpeg -q:v 5 -f mpjpeg -listen 1 http://127.0.0.1:${WSL_STREAM_PORT}/stream </dev/null >>/tmp/agent-workspace-ffmpeg.log 2>&1 & sleep 1.5; echo OK`,
      15_000
    )
  } catch {
    // 拉起失败 → handler 返回 503，面板 onError 回退快照模式
  }
}

/** 鼠标点击 */
export async function click(x: number, y: number, button: 'left' | 'right' | 'middle' = 'left'): Promise<boolean> {
  try {
    const btn = button === 'left' ? 1 : button === 'right' ? 3 : 2
    await execWslDisplay(`xdotool mousemove ${x} ${y} click ${btn}`)
    return true
  } catch { return false }
}

/** 双击 */
export async function doubleClick(x: number, y: number): Promise<boolean> {
  try {
    await execWslDisplay(`xdotool mousemove ${x} ${y} click --repeat 2 1`)
    return true
  } catch { return false }
}

/** 鼠标移动 */
export async function mouseMove(x: number, y: number): Promise<boolean> {
  try {
    await execWslDisplay(`xdotool mousemove ${x} ${y}`)
    return true
  } catch { return false }
}

/** 按键 */
export async function keyPress(keys: string): Promise<boolean> {
  try {
    await execWslDisplay(`xdotool key ${keys}`)
    return true
  } catch { return false }
}

/** 输入文本 */
export async function typeText(text: string): Promise<boolean> {
  try {
    const escaped = text.replace(/'/g, "'\\''")
    await execWslDisplay(`xdotool type -- '${escaped}'`)
    return true
  } catch { return false }
}

/** 在 WSL 内执行命令 — timeoutSec 可放宽（上限 600s）；stdin 单向喂入命令（非 TTY） */
export async function exec(command: string, timeoutSec = 30, stdin?: string): Promise<{ success: boolean; output: string; error: string }> {
  let cmd = command
  if (stdin && stdin.length > 0) {
    try {
      const b64 = Buffer.from(stdin, 'utf8').toString('base64')
      await execWslRaw(`echo ${b64} | base64 -d > /tmp/.agent-stdin`, 10_000)
      cmd = `{ ${command}\n} < /tmp/.agent-stdin; rm -f /tmp/.agent-stdin`
    } catch { /* stdin 部署失败则按无 stdin 执行 */ }
  }
  const capped = Math.min(Math.max(Math.floor(timeoutSec) || 30, 1), 600)
  try {
    const output = await execWslDisplay(cmd, capped * 1000)
    return { success: true, output, error: '' }
  } catch (e) {
    return { success: false, output: '', error: (e as Error).message }
  }
}

/** 启动应用（可带参数，如 URL/文件路径）— setsid + 三流重定向完全脱离会话，防 GUI 应用占用管道导致调用挂起。
 *  返回 alive 表示启动后 ~3s 内探测到同名进程；进程名与启动名不同（.desktop 包装）时不据此判死 */
export async function launchApp(appName: string, args?: string): Promise<{ success: boolean; alive: boolean; error?: string }> {
  if (!/^[a-zA-Z0-9._/-]+$/.test(appName)) return { success: false, alive: false, error: '应用名含非法字符' }
  let safeArgs = ''
  if (args && args.trim()) {
    // 禁止 shell 链接元字符；URL/路径常用的 :/?#=& 等放行
    if (/[;|&`$><\n]/.test(args)) return { success: false, alive: false, error: 'args 含被禁止的 shell 元字符（; | & ` $ > < 换行）' }
    safeArgs = ' ' + args.trim()
  }
  try {
    await execWslDisplay(
      `setsid ${appName}${safeArgs} </dev/null >>/tmp/agent-workspace-app.log 2>&1 &`
    )
  } catch (e) {
    return { success: false, alive: false, error: (e as Error).message.slice(0, 200) }
  }
  let alive = false
  for (let i = 0; i < 6; i++) {
    await new Promise(r => setTimeout(r, 500))
    try {
      const out = await execWslRaw(`pgrep -f "^${appName}( |$)" >/dev/null 2>&1 && echo ALIVE || true`, 8_000)
      if (out.includes('ALIVE')) { alive = true; break }
    } catch { /* 重试 */ }
  }
  return { success: true, alive }
}

/** 滚轮滚动 — xdotool 虚拟按键 4/5（纵向）6/7（横向） */
export async function scroll(direction: 'up' | 'down' | 'left' | 'right', amount = 3): Promise<boolean> {
  const btn = direction === 'up' ? 4 : direction === 'down' ? 5 : direction === 'left' ? 6 : 7
  const n = Math.min(Math.max(Math.floor(amount) || 3, 1), 20)
  try {
    await execWslDisplay(`for i in $(seq 1 ${n}); do xdotool click ${btn}; done`)
    return true
  } catch { return false }
}

/** 拖拽 — 按下左键移动到终点后松开（--sync 确保路径逐点完成） */
export async function drag(x1: number, y1: number, x2: number, y2: number): Promise<boolean> {
  try {
    await execWslDisplay(`xdotool mousemove ${x1} ${y1} mousedown 1 mousemove --sync ${x2} ${y2} mouseup 1`)
    return true
  } catch { return false }
}

/** 按下/松开按键 — 与 click 组合实现「按住修饰键再点击」等手势（用完必须 key_up） */
export async function keyDown(keys: string): Promise<boolean> {
  try { await execWslDisplay(`xdotool keydown ${keys}`); return true } catch { return false }
}

export async function keyUp(keys: string): Promise<boolean> {
  try { await execWslDisplay(`xdotool keyup ${keys}`); return true } catch { return false }
}

/** 读取桌面剪贴板内容（与 paste 动作构成双向通道） */
export async function clipboardRead(): Promise<string | null> {
  try {
    return (await execWslDisplay('xclip -selection clipboard -o 2>/dev/null', 10_000)) || null
  } catch { return null }
}

/** 窗口管理 — 按 id（window_list 取得）或标题子串定位，经 wmctrl 操作 */
export async function windowOp(
  op: 'activate' | 'close' | 'move' | 'resize' | 'minimize' | 'maximize' | 'restore',
  target: { windowId?: string; title?: string },
  geo?: { x?: number; y?: number; w?: number; h?: number }
): Promise<{ success: boolean; error?: string }> {
  let id = (target.windowId || '').trim()
  if (!id && target.title?.trim()) {
    const esc = target.title.trim().replace(/'/g, "'\\''")
    try {
      id = (await execWslDisplay(`wmctrl -l | grep -iF '${esc}' | head -1 | awk '{print $1}'`, 10_000)).trim()
    } catch { /* 未找到 */ }
  }
  if (!id || !/^0x[0-9a-fA-F]+$/.test(id)) {
    return { success: false, error: '未找到目标窗口 — 先用 window_list 获取窗口 id，或提供可匹配的标题子串' }
  }
  // -1 表示保持该维度不变（wmctrl -e 的 gravity,x,y,w,h）
  const geoArg = `0,${geo?.x ?? -1},${geo?.y ?? -1},${geo?.w ?? -1},${geo?.h ?? -1}`
  const cmds: Record<string, string> = {
    activate: `wmctrl -i -a ${id}`,
    close: `wmctrl -i -c ${id}`,
    move: `wmctrl -i -r ${id} -e ${geoArg}`,
    resize: `wmctrl -i -r ${id} -e ${geoArg}`,
    minimize: `wmctrl -i -r ${id} -b add,hidden`,
    restore: `wmctrl -i -r ${id} -b remove,hidden`,
    maximize: `wmctrl -i -r ${id} -b add,maximized_vert,maximized_horz`,
  }
  if (!cmds[op]) return { success: false, error: `未知窗口操作: ${op}` }
  try {
    await execWslDisplay(cmds[op], 10_000)
    return { success: true }
  } catch (e) {
    return { success: false, error: (e as Error).message.slice(0, 200) }
  }
}

/** 修改桌面分辨率 — 写入配置后重跑 init 脚本重启 Xvfb/WM/面板/画面流（会关闭当前所有窗口） */
export async function setResolution(width: number, height: number): Promise<{ success: boolean; error?: string }> {
  const w = Math.floor(width)
  const h = Math.floor(height)
  if (!(w >= 640 && w <= 3840 && h >= 480 && h <= 2160)) {
    return { success: false, error: '分辨率超出允许范围（宽 640-3840，高 480-2160）' }
  }
  try {
    await execWslRaw(`echo '${w}x${h}' > /tmp/agent-workspace-resolution`, 10_000)
    await execWslRaw(`bash ${WSL_INIT_SCRIPT}`, 180_000)
    return { success: true }
  } catch (e) {
    return { success: false, error: (e as Error).message.slice(0, 200) }
  }
}

/** 粘贴文本（经剪贴板）— CJK 直输在部分应用（浏览器）受限，剪贴板粘贴是可靠通道。
 *  xclip 必须在同一次 exec 内存活到 ctrl+v 完成（它持有选区所有权），因此合并为一条复合命令 */
export async function pasteText(text: string): Promise<boolean> {
  const b64 = Buffer.from(text, 'utf8').toString('base64')
  try {
    await execWslDisplay(
      `echo ${b64} | base64 -d > /tmp/.agent-paste && ` +
      `xclip -selection clipboard -i /tmp/.agent-paste & ` +
      `sleep 0.4; xdotool key --clearmodifiers ctrl+v; sleep 0.3; pkill xclip 2>/dev/null; true`,
      20_000
    )
    return true
  } catch { return false }
}

/** 列出桌面窗口 — xdotool 自身即可枚举，无需 wmctrl */
export async function listWindows(): Promise<{ id: string; title: string }[]> {
  try {
    const out = await execWslDisplay(
      `xdotool search --onlyvisible --name "" 2>/dev/null | while read id; do echo "$id|$(xdotool getwindowname "$id" 2>/dev/null)"; done`
    )
    return out.split('\n')
      .map((line) => line.trim())
      .filter((line) => line.includes('|'))
      .map((line) => {
        const sep = line.indexOf('|')
        return { id: line.slice(0, sep), title: line.slice(sep + 1) }
      })
      .filter((w) => w.title)
  } catch { return [] }
}
