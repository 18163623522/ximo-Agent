import type { Tool } from '@main/tools/Tool'
import type { ToolDefinition, ToolCall, ToolResult } from '@shared/types'
import { virtualDesktopManager } from './VirtualDesktopManager'

/**
 * VirtualDesktopTool — Agent 隔离工作区工具
 *
 * 设计灵感：agent-workspace-linux
 * ——给 Agent 一个独占的隔离工作环境，通过最小化/恢复窗口实现逻辑桌面切换。
 *
 * 支持操作：
 * - list: 列出所有工作区
 * - switch: 切换到指定工作区（最小化其他工作区的窗口）
 * - create: 创建新工作区
 * - remove: 删除工作区（窗口合并到主桌面）
 * - rename: 重命名工作区
 * - list_windows: 列出工作区上的窗口
 * - move_window: 将窗口移动到指定工作区
 * - focus_window: 聚焦指定窗口（恢复并前置）
 *
 * 使用策略：
 * - 复杂任务开始时创建专用工作区，将相关窗口组织到一起
 * - 任务完成后可删除工作区，窗口自动合并回主桌面
 * - Agent 可以自由管理工作区，不影响用户真实桌面布局
 */
export class VirtualDesktopTool implements Tool {
  readonly definition: ToolDefinition = {
    name: 'virtual_desktop',
    description:
      '管理 Agent 隔离工作区（虚拟桌面）。通过 action 参数指定操作类型。\n' +
      'list: 列出所有工作区（返回 id/name/isActive/windowCount）\n' +
      'switch: 切换到指定工作区（需要 desktopId，最小化其他工作区的窗口）\n' +
      'create: 创建新工作区并返回更新后的列表（可选 name 参数指定名称）\n' +
      'remove: 删除指定工作区（需要 desktopId，窗口合并到主桌面）\n' +
      'rename: 重命名工作区（需要 desktopId 和 name）\n' +
      'list_windows: 列出工作区上的窗口（可选 desktopId，缺省为当前工作区）\n' +
      'move_window: 将窗口移动到指定工作区（需要 windowTitle，可选 desktopId）\n' +
      'focus_window: 聚焦指定窗口（需要 windowTitle，恢复并前置该窗口）\n' +
      '使用策略：复杂任务开始时创建专用工作区，将相关窗口组织到一起，任务完成后可删除工作区。',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          description: '操作类型',
          enum: ['list', 'switch', 'create', 'remove', 'rename', 'list_windows', 'move_window', 'focus_window']
        },
        desktopId: {
          type: 'string',
          description: '目标工作区 ID（switch/remove/rename/list_windows/move_window 时使用）',
          default: ''
        },
        name: {
          type: 'string',
          description: 'create: 新工作区名称；rename: 新名称',
          default: ''
        },
        windowTitle: {
          type: 'string',
          description: 'move_window/focus_window: 窗口标题关键词（支持模糊匹配）',
          default: ''
        }
      },
      required: ['action']
    }
  }

  async execute(toolCall: ToolCall): Promise<ToolResult> {
    const action = (toolCall.arguments.action as string) || ''
    const desktopId = (toolCall.arguments.desktopId as string) || ''
    const name = (toolCall.arguments.name as string) || ''
    const windowTitle = (toolCall.arguments.windowTitle as string) || ''

    try {
      let result
      switch (action) {
        case 'list':
          result = await virtualDesktopManager.list()
          break
        case 'switch':
          if (!desktopId) return this.error(toolCall.id, 'switch 需要 desktopId 参数')
          result = await virtualDesktopManager.switch(desktopId)
          break
        case 'create':
          result = await virtualDesktopManager.create(name || undefined)
          break
        case 'remove':
          if (!desktopId) return this.error(toolCall.id, 'remove 需要 desktopId 参数')
          result = await virtualDesktopManager.remove(desktopId)
          break
        case 'rename':
          if (!desktopId) return this.error(toolCall.id, 'rename 需要 desktopId 参数')
          if (!name) return this.error(toolCall.id, 'rename 需要 name 参数')
          result = await virtualDesktopManager.rename(desktopId, name)
          break
        case 'list_windows':
          result = await virtualDesktopManager.listWindows(desktopId || undefined)
          break
        case 'move_window':
          if (!windowTitle) return this.error(toolCall.id, 'move_window 需要 windowTitle 参数')
          result = await virtualDesktopManager.moveWindow(windowTitle, desktopId || undefined)
          break
        case 'focus_window':
          if (!windowTitle) return this.error(toolCall.id, 'focus_window 需要 windowTitle 参数')
          result = await virtualDesktopManager.focusWindow(windowTitle)
          break
        default:
          return this.error(toolCall.id, `未知操作类型: ${action}`)
      }

      const lines = this.formatResult(action, result as unknown as Record<string, unknown>)
      return {
        toolCallId: toolCall.id,
        toolName: 'virtual_desktop',
        content: lines,
        success: result.success,
        error: result.error,
        metadata: { action, desktopId, name, windowTitle }
      }
    } catch (e) {
      return this.error(toolCall.id, `工作区操作失败 [${action}]：${(e as Error).message}`)
    }
  }

  private error(id: string, msg: string): ToolResult {
    return { toolCallId: id, toolName: 'virtual_desktop', content: '', success: false, error: msg }
  }

  private formatResult(action: string, result: Record<string, unknown>): string {
    if (!result.success) {
      return `❌ 操作失败：${result.error || '未知错误'}`
    }

    const lines: string[] = []

    if ((action === 'list' || action === 'create' || action === 'remove' || action === 'rename') && Array.isArray(result.desktops)) {
      const desktops = result.desktops as Array<Record<string, unknown>>
      const titleMap: Record<string, string> = {
        list: '🖥️ Agent 工作区列表',
        create: '✅ 新工作区已创建',
        remove: '✅ 工作区已删除',
        rename: '✅ 工作区已重命名'
      }
      lines.push(`## ${titleMap[action] || '工作区列表'}`, '')
      desktops.forEach((d, i) => {
        const active = d.isActive ? ' 🔥' : ''
        const dname = d.name || `工作区 ${i + 1}`
        lines.push(`**${i + 1}.** \`${d.id}\` — ${dname}${active}`)
        lines.push(`   窗口数：${d.windowCount ?? 0}`)
        lines.push('')
      })
      lines.push(`共 ${desktops.length} 个工作区。`)
      if (action === 'create') {
        lines.push('可使用 `virtual_desktop(action="switch", desktopId="上述ID")` 切换到新工作区。')
      }
    } else if (action === 'list_windows' && Array.isArray(result.windows)) {
      const windows = result.windows as Array<Record<string, unknown>>
      lines.push('## 🪟 工作区窗口列表', '')
      if (windows.length === 0) {
        lines.push('（当前工作区上没有可见窗口）')
      } else {
        windows.forEach((w, i) => {
          const focused = w.isFocused ? ' 🔥' : ''
          lines.push(`**${i + 1}.** ${w.title}${focused}`)
          if (w.appName) lines.push(`   应用：${w.appName}`)
        })
        lines.push('', `共 ${windows.length} 个窗口。`)
      }
    } else if (action === 'switch') {
      lines.push('✅ 已切换到目标工作区')
    } else if (action === 'move_window') {
      lines.push('✅ 已将窗口移动到目标工作区')
    } else if (action === 'focus_window') {
      lines.push('✅ 已聚焦目标窗口')
    } else {
      lines.push('✅ 操作完成')
    }

    return lines.join('\n')
  }
}
