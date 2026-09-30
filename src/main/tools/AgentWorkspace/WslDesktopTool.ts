import type { Tool } from '@main/tools/Tool'
import type { ToolDefinition, ToolCall, ToolResult, StreamChunk } from '@shared/types'
import { agentWorkspaceManager } from './AgentWorkspaceManager'

/**
 * WslDesktopTool — Agent 操作 WSL 隔离桌面的工具
 *
 * Agent 通过此工具在 WSL 内的 Xvfb 桌面上操作：
 * - 感知: screenshot / window_list / clipboard_read
 * - 操控: click / double_click / drag / mouse_move / scroll(四向) / key_press / key_down / key_up / type / paste
 * - 窗口: window_op（激活/关闭/移动/缩放/最小化/最大化/还原）
 * - 系统: exec（可调 timeout / stdin）/ launch（可带 args）/ set_resolution
 *
 * 所有操作都在 WSL2 隔离环境内，不影响用户真实桌面。
 * 桌面会话假死时自动重启并重试（ensureAlive 自愈）。
 */

/** 需要 X 会话存活的操作 — 执行前经 ensureAlive 探测/自愈（exec 不依赖 X；set_resolution 自带重启） */
const NEEDS_X_ACTIONS = new Set([
  'screenshot', 'click', 'double_click', 'mouse_move', 'scroll', 'drag',
  'key_press', 'key_down', 'key_up', 'type', 'paste',
  'clipboard_read', 'window_list', 'window_op', 'launch'
])

/** 操作后自动截图的豁免 — 纯读操作与 exec 无画面变化 */
const NO_AUTOSHOT_ACTIONS = new Set(['screenshot', 'exec', 'clipboard_read', 'window_list'])

const WINDOW_OPS = ['activate', 'close', 'move', 'resize', 'minimize', 'maximize', 'restore'] as const

export class WslDesktopTool implements Tool {
  readonly definition: ToolDefinition = {
    name: 'wsl_desktop',
    description:
      '操作 WSL 隔离桌面环境。通过 action 参数指定操作类型。\n' +
      '感知: screenshot 截屏（返回 base64 图片）| window_list 列出窗口（id+标题）| clipboard_read 读剪贴板\n' +
      '鼠标: click 点击（x,y，可选 button）| double_click 双击 | drag 拖拽（x,y 起点 → x2,y2 终点）| mouse_move 移动 | scroll 滚动（direction: up/down/left/right，amount 格数）\n' +
      '键盘: key_press 按键（如 "ctrl+c"、"Return"）| key_down 按住 | key_up 松开（组合可实现按住 Shift 再点击）| type 输入文本 | paste 经剪贴板粘贴（CJK 直输受限的应用用这个）\n' +
      '窗口: window_op（op: activate/close/move/resize/minimize/maximize/restore；用 window_id 或 title 子串定位；move/resize 传 x,y,w,h，-1/缺省为保持不变）\n' +
      '系统: exec 在 WSL 内执行 shell 命令（command 必填；timeout 秒数默认 30 上限 600；stdin 可选单向喂入）| launch 启动应用（app，如 "firefox-esr"；args 可带 URL/路径参数）| set_resolution 调整桌面分辨率（resolution 如 "1920x1080"，桌面会重启，窗口全关）\n' +
      '默认分辨率 1280x800，所有操作在隔离的 Xvfb 虚拟显示上执行；桌面假死会自动重启后重试。',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          description: '操作类型',
          enum: ['screenshot', 'click', 'double_click', 'mouse_move', 'scroll', 'drag', 'key_press', 'key_down', 'key_up', 'type', 'paste', 'clipboard_read', 'window_list', 'window_op', 'exec', 'launch', 'set_resolution']
        },
        x: { type: 'number', description: 'X 坐标（click/double_click/mouse_move；drag 起点；window_op move）', default: 0 },
        y: { type: 'number', description: 'Y 坐标（同 x）', default: 0 },
        x2: { type: 'number', description: '拖拽终点 X（drag）', default: 0 },
        y2: { type: 'number', description: '拖拽终点 Y（drag）', default: 0 },
        w: { type: 'number', description: '宽度（window_op resize）' },
        h: { type: 'number', description: '高度（window_op resize）' },
        button: { type: 'string', description: '鼠标按钮（click）', enum: ['left', 'right', 'middle'], default: 'left' },
        direction: { type: 'string', description: '滚动方向（scroll）', enum: ['up', 'down', 'left', 'right'], default: 'down' },
        amount: { type: 'number', description: '滚动格数（scroll，默认 3）', default: 3 },
        keys: { type: 'string', description: '按键组合（key_press/key_down/key_up），如 "ctrl+c"、"Return"、"shift"', default: '' },
        text: { type: 'string', description: '输入文本（type/paste）', default: '' },
        command: { type: 'string', description: 'Shell 命令（exec）', default: '' },
        timeout: { type: 'number', description: '命令超时秒数（exec，默认 30，上限 600）', default: 30 },
        stdin: { type: 'string', description: '喂入命令 stdin 的文本（exec 可选，非 TTY 单向）' },
        app: { type: 'string', description: '应用名称（launch），如 "firefox-esr"、"xfce4-terminal"', default: '' },
        args: { type: 'string', description: '应用启动参数（launch 可选），如 "https://example.com" 或文件路径' },
        op: { type: 'string', description: '窗口操作（window_op）', enum: ['activate', 'close', 'move', 'resize', 'minimize', 'maximize', 'restore'] },
        window_id: { type: 'string', description: '目标窗口 id（window_op，window_list 取得，形如 0x03c00007）' },
        title: { type: 'string', description: '目标窗口标题子串（window_op 备选定位，不传 window_id 时用）' },
        resolution: { type: 'string', description: '分辨率（set_resolution），格式 "宽x高"，如 "1920x1080"' }
      },
      required: ['action']
    }
  }

  async execute(toolCall: ToolCall, onChunk?: (chunk: StreamChunk) => void): Promise<ToolResult> {
    const action = (toolCall.arguments.action as string) || ''
    const x = Number(toolCall.arguments.x) || 0
    const y = Number(toolCall.arguments.y) || 0
    const button = (toolCall.arguments.button as string) || 'left'
    const keys = (toolCall.arguments.keys as string) || ''
    const text = (toolCall.arguments.text as string) || ''
    const command = (toolCall.arguments.command as string) || ''
    const app = (toolCall.arguments.app as string) || ''

    onChunk?.({ toolStatus: 'calling', toolName: 'wsl_desktop' })

    try {
      // 桌面会话预检 — 区分「工作区未启动」「会话假死已自愈」「自愈失败」，操作失败不再无归因
      if (NEEDS_X_ACTIONS.has(action)) {
        if (!agentWorkspaceManager.getState().running) {
          return this.error(toolCall.id, '工作区未启动。请用户在 Agent 桌面面板点击「启动」后再操作')
        }
        const alive = await agentWorkspaceManager.ensureAlive()
        if (!alive) {
          return this.error(toolCall.id, '桌面会话无响应，自动重启失败。请用户在 Agent 桌面面板重新启动工作区')
        }
      }

      let success = false
      let content = ''
      let screenshot: string | undefined

      switch (action) {
        case 'screenshot':
          const img = await agentWorkspaceManager.screenshot()
          if (img) {
            success = true
            content = '📸 桌面截图已获取'
            screenshot = img
          } else {
            content = '❌ 截图失败，请确认工作区已启动'
          }
          break

        case 'click':
          success = await agentWorkspaceManager.click(x, y, button as 'left' | 'right' | 'middle')
          content = success ? `✅ 已点击 (${x}, ${y}) [${button}]` : `❌ 点击失败`
          break

        case 'double_click':
          success = await agentWorkspaceManager.doubleClick(x, y)
          content = success ? `✅ 已双击 (${x}, ${y})` : `❌ 双击失败`
          break

        case 'mouse_move':
          success = await agentWorkspaceManager.mouseMove(x, y)
          content = success ? `✅ 鼠标已移动到 (${x}, ${y})` : `❌ 鼠标移动失败`
          break

        case 'drag': {
          const x2 = Number(toolCall.arguments.x2) || 0
          const y2 = Number(toolCall.arguments.y2) || 0
          success = await agentWorkspaceManager.drag(x, y, x2, y2)
          content = success ? `✅ 已拖拽 (${x}, ${y}) → (${x2}, ${y2})` : `❌ 拖拽失败`
          break
        }

        case 'scroll': {
          const dir = (toolCall.arguments.direction as 'up' | 'down' | 'left' | 'right') || 'down'
          const amount = Number(toolCall.arguments.amount) || 3
          success = await agentWorkspaceManager.scroll(dir, amount)
          content = success ? `✅ 已${dir === 'up' ? '上' : dir === 'down' ? '下' : dir === 'left' ? '左' : '右'}滚 ${amount} 格` : `❌ 滚动失败`
          break
        }

        case 'key_press':
          if (!keys) return this.error(toolCall.id, 'key_press 需要 keys 参数')
          success = await agentWorkspaceManager.keyPress(keys)
          content = success ? `✅ 已按键: ${keys}` : `❌ 按键失败`
          break

        case 'key_down':
          if (!keys) return this.error(toolCall.id, 'key_down 需要 keys 参数')
          success = await agentWorkspaceManager.keyDown(keys)
          content = success ? `✅ 已按下: ${keys}（用 key_up 松开）` : `❌ 按下失败`
          break

        case 'key_up':
          if (!keys) return this.error(toolCall.id, 'key_up 需要 keys 参数')
          success = await agentWorkspaceManager.keyUp(keys)
          content = success ? `✅ 已松开: ${keys}` : `❌ 松开失败`
          break

        case 'type':
          if (!text) return this.error(toolCall.id, 'type 需要 text 参数')
          success = await agentWorkspaceManager.typeText(text)
          content = success ? `✅ 已输入文本: ${text.slice(0, 50)}${text.length > 50 ? '...' : ''}` : `❌ 输入失败`
          break

        case 'paste':
          if (!text) return this.error(toolCall.id, 'paste 需要 text 参数')
          success = await agentWorkspaceManager.pasteText(text)
          content = success ? `✅ 已经剪贴板粘贴文本: ${text.slice(0, 50)}${text.length > 50 ? '...' : ''}` : `❌ 粘贴失败`
          break

        case 'clipboard_read': {
          const clip = await agentWorkspaceManager.clipboardRead()
          success = clip !== null && clip !== undefined
          content = success ? `📋 剪贴板内容:\n${(clip || '').slice(0, 2000)}` : `❌ 读取剪贴板失败（或为空）`
          break
        }

        case 'window_list': {
          const wins = await agentWorkspaceManager.listWindows()
          success = true
          content = wins.length > 0
            ? `当前桌面窗口（${wins.length} 个）:\n` + wins.map((w, i) => `${i + 1}. [${w.id}] ${w.title}`).join('\n')
            : '当前桌面没有可见窗口'
          break
        }

        case 'window_op': {
          const op = toolCall.arguments.op as string
          if (!op || !(WINDOW_OPS as readonly string[]).includes(op)) {
            return this.error(toolCall.id, `window_op 需要 op 参数（${WINDOW_OPS.join('/')}）`)
          }
          // 区分「未提供」与 0 — 移动到 (0,0) 是合法目标
          const num = (v: unknown): number | undefined =>
            typeof v === 'number' && Number.isFinite(v) ? v : undefined
          const r = await agentWorkspaceManager.windowOp(
            op as (typeof WINDOW_OPS)[number],
            {
              windowId: typeof toolCall.arguments.window_id === 'string' ? toolCall.arguments.window_id : undefined,
              title: typeof toolCall.arguments.title === 'string' ? toolCall.arguments.title : undefined,
            },
            {
              x: num(toolCall.arguments.x),
              y: num(toolCall.arguments.y),
              w: num(toolCall.arguments.w),
              h: num(toolCall.arguments.h),
            }
          )
          success = r.success
          content = r.success ? `✅ 窗口操作完成: ${op}` : `❌ 窗口操作失败: ${r.error}`
          break
        }

        case 'exec': {
          if (!command) return this.error(toolCall.id, 'exec 需要 command 参数')
          const timeoutSec = Number(toolCall.arguments.timeout) || 30
          const stdin = typeof toolCall.arguments.stdin === 'string' ? toolCall.arguments.stdin : undefined
          const execResult = await agentWorkspaceManager.exec(command, timeoutSec, stdin)
          success = execResult.success
          if (execResult.success) {
            // 首尾保留截断 — 长输出（安装日志/编译错误）头部与尾部都可见
            const raw = execResult.output.trim()
            const shown = raw.length > 8000
              ? raw.slice(0, 6000) + `\n...[中间省略 ${raw.length - 7500} 字符]...\n` + raw.slice(-1500)
              : raw
            content = `✅ 命令执行成功\n\`\`\`\n${shown}\n\`\`\``
          } else {
            content = `❌ 命令执行失败: ${execResult.error}`
          }
          break
        }

        case 'launch': {
          if (!app) return this.error(toolCall.id, 'launch 需要 app 参数')
          const r = await agentWorkspaceManager.launchApp(
            app,
            typeof toolCall.arguments.args === 'string' ? toolCall.arguments.args : undefined
          )
          success = r.success
          content = r.success
            ? (r.alive
                ? `✅ 已启动应用: ${app}（进程运行中）`
                : `⚠️ 已发出启动命令，但 3 秒内未检测到「${app}」进程 — 可能启动失败，可用 exec 查看 /tmp/agent-workspace-app.log`)
            : `❌ 启动失败: ${r.error || app}`
          break
        }

        case 'set_resolution': {
          const res = String(toolCall.arguments.resolution || '')
          const m = res.match(/^(\d{3,4})x(\d{3,4})$/)
          if (!m) return this.error(toolCall.id, 'set_resolution 需要 resolution 参数，格式 "宽x高"（如 "1920x1080"）')
          const r = await agentWorkspaceManager.setResolution(Number(m[1]), Number(m[2]))
          success = r.success
          content = r.success
            ? `✅ 分辨率已切换为 ${res}（桌面已重启，窗口已关闭）`
            : `❌ 分辨率切换失败: ${r.error}`
          break
        }

        default:
          return this.error(toolCall.id, `未知操作类型: ${action}`)
      }

      // 操作后自动截图（读操作与 exec 除外）— 用户面板可见每次操作的即时画面
      if (success && !NO_AUTOSHOT_ACTIONS.has(action)) {
        const autoShot = await agentWorkspaceManager.screenshot()
        if (autoShot) screenshot = autoShot
      }

      return {
        toolCallId: toolCall.id,
        toolName: 'wsl_desktop',
        content,
        success,
        screenshot,
        metadata: { action, x, y, button, keys, text: text.slice(0, 100), command: command.slice(0, 100), app }
      }
    } catch (e) {
      return this.error(toolCall.id, `WSL 桌面操作失败 [${action}]：${(e as Error).message}`)
    }
  }

  private error(id: string, msg: string): ToolResult {
    return { toolCallId: id, toolName: 'wsl_desktop', content: '', success: false, error: msg }
  }
}
