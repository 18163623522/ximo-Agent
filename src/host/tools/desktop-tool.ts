/**
 * desktop 工具 — 主机侧 Agent 的桌面 API 总线入口（阶段 2）
 *
 * 与驾驶舱共用同一个 DesktopBus（headless-first：Agent 和 GUI 是同等地位的客户端）。
 * 全部操作走结构化 JSON（窗口树/应用/键盘），不依赖截图 —— 阶段 2 灵魂指标
 * 「同一办公任务纯 API 零截图完成」靠的就是这个工具。
 *
 * 权限：desktop 全量 allow（Permission.ts，主机隔离桌面语义与 wsl_desktop 一致；
 * 命令执行不在本工具内 — 走 terminal_exec 审批）。
 */
import type { Tool } from '../../main/tools/Tool'
import type { ToolDefinition, ToolCall, ToolResult, StreamChunk } from '../../shared/types'
import type { DesktopBus } from '../desktop/bus'
import type { DesktopAction, DesktopWindow } from '../../shared/types/cockpit'

const ACTIONS: DesktopAction[] = [
  'window.list', 'window.op', 'app.launch', 'app.list', 'app.available', 'key', 'type', 'active',
  'mouse.move', 'mouse.click', 'mouse.scroll', 'screen.size',
  'clipboard.read', 'clipboard.write', 'screen.snapshot',
]

function fmtWindow(w: DesktopWindow): string {
  const app = w.app ? ` [${w.app}]` : ''
  return `${w.id}${app}「${w.title}」@(${w.x},${w.y}) ${w.w}x${w.h}`
}

/** 结果转 LLM 可读文本 — 列表类格式化为行，其余紧凑 JSON */
function formatData(data: unknown): string {
  if (Array.isArray(data) && data.length > 0 && typeof data[0] === 'object' && 'id' in (data[0] as object)) {
    return (data as DesktopWindow[]).map(fmtWindow).join('\n')
  }
  if (Array.isArray(data) && data.length === 0) return '（空）'
  return JSON.stringify(data)
}

export class DesktopBusTool implements Tool {
  readonly definition: ToolDefinition = {
    name: 'desktop',
    description:
      '操作本机桌面（API 总线，零截图自动化）。\n' +
      '动作: window.list 列窗口（结构化：id/应用/标题/位置尺寸）| window.op 窗口操作（op: activate/close/move/resize/minimize/maximize/restore，用 window_id 或 title 子串定位）| app.available 列出**可启动的应用**（开始前先查，别猜应用名）| app.launch 启动应用（app 必填，取 app.available 的 exec 字段；args 可选数组）| app.list 运行中应用 | key 按键（keys 如 "ctrl+s"、"Return"）| type 输入文本（type 到当前聚焦窗口）| active 当前聚焦窗口\n' +
      '典型工作流：app.available 看有什么可用 → app.launch 打开应用 → window.list 确认窗口出现 → window.op(activate) 聚焦 → type/key 输入。全程纯 API，无需截图。\n' +
      '鼠标: mouse.move 移动（x,y）| mouse.click 点击（x,y,button: left/middle/right）| mouse.scroll 滚动（direction: up/down/left/right, amount 格数）；screen.size 读屏幕几何（交互坐标换算）。\n' +
      '剪贴板: clipboard.read 读剪贴板（读取当前应用内容的首选方式——比截图快且准，无需视觉模型）| clipboard.write 写剪贴板（text 必填，随后用 key ctrl+v 粘贴到目标应用）。\n' +
      '截图: screen.snapshot 单帧截图（兜底感知——仅在纯 API 无法判断时用，如确认 GUI 渲染结果）。',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', description: '操作类型', enum: ACTIONS },
        op: { type: 'string', description: '窗口操作（window.op）', enum: ['activate', 'close', 'move', 'resize', 'minimize', 'maximize', 'restore'] },
        window_id: { type: 'string', description: '目标窗口 id（window_list 取得，形如 0x03c00007）' },
        title: { type: 'string', description: '窗口标题子串（window_id 的备选定位）' },
        x: { type: 'number', description: 'move/resize（-1 缺省保持不变）' },
        y: { type: 'number', description: '同 x' },
        w: { type: 'number', description: '同 x' },
        h: { type: 'number', description: '同 x' },
        app: { type: 'string', description: '应用名（app.launch），如 "xfce4-terminal"、"firefox-esr"' },
        args: { type: 'array', items: { type: 'string' }, description: '启动参数（app.launch 可选）' },
        keys: { type: 'string', description: '按键组合（key），如 "ctrl+s"' },
        text: { type: 'string', description: '输入文本（type）' },
      },
      required: ['action'],
    },
  }

  constructor(private readonly bus: DesktopBus) {}

  async execute(toolCall: ToolCall, onChunk?: (c: StreamChunk) => void): Promise<ToolResult> {
    const action = (toolCall.arguments.action as DesktopAction) || ''
    onChunk?.({ toolStatus: 'calling', toolName: 'desktop' })
    if (!ACTIONS.includes(action)) {
      return this.error(toolCall.id, `未知操作: ${String(action)}（可选: ${ACTIONS.join('/')}）`)
    }
    try {
      const data = await this.bus.dispatch(action, toolCall.arguments)
      onChunk?.({ toolStatus: 'done', toolName: 'desktop' })

      // 截图动作 — base64 只回状态（避免撑爆上下文），提示改用 vision 工具分析
      if (action === 'screen.snapshot') {
        const shot = (data as { screenshot?: string })?.screenshot
        return {
          toolCallId: toolCall.id,
          toolName: 'desktop',
          content: '📸 桌面截图已获取（base64 已随结果附带，供 UI 展示）。注意：纯 API 动作（window.list / clipboard.read）通常比截图更快更准。',
          success: true,
          ...(shot ? { screenshot: shot } : {}),
          metadata: { action },
        }
      }

      return {
        toolCallId: toolCall.id,
        toolName: 'desktop',
        content: formatData(data),
        success: true,
        metadata: { action },
      }
    } catch (e) {
      onChunk?.({ toolStatus: 'done', toolName: 'desktop' })
      return this.error(toolCall.id, (e as Error).message)
    }
  }

  private error(id: string, msg: string): ToolResult {
    return { toolCallId: id, toolName: 'desktop', content: '', success: false, error: msg }
  }
}
