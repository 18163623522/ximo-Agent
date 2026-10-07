/**
 * task-runner v1 — 复用主应用 agent-loop（ximo-OS 阶段 0.5）
 *
 * 与 v0 的差异：Agent 循环、权限审批、上下文压缩、规划轮全部来自主应用
 * deepseek 层（已确认零 electron 依赖）；工具域从主应用可移植模块组加载
 * （file_system / terminal / git / web_intelligence / memory / skill），
 * Windows 专属域（Browser/ComputerUse/VirtualDesktop/AgentWorkspace）不上主机。
 *
 * 隔离模型（阶段 0 形态，阶段 3 升级为按任务用户/沙箱）：
 * - 任务串行执行，进程 cwd 切到任务工作区（文件工具的相对路径语义）
 * - security-guard 写白名单锁死工作区
 * - electron 以 shim 替身提供（store/paths 的 app.getPath 指向主机数据目录）
 */
import '../electron-shim'
import { agentLoop } from '../../main/deepseek/agent-loop'
import { ensureModuleGroupsLoaded } from '../../main/tools/lazy-registry'
export { ensureModuleGroupsLoaded }
import { toolRegistry } from '../../main/tools/ToolRegistry'
export { toolRegistry }
import { setAllowedWriteRoots } from '../../main/security-guard'
import { loadSettings, saveSettings } from '../../main/store'
import { DesktopBusTool } from '../tools/desktop-tool'
import { OfficeDocsTool } from '../tools/office-docs-tool'
import type { DesktopBus } from '../desktop/bus'
import type { ApiMessage, AppSettings, ChatRequest, ModelId, Mode, StreamChunk, ToolContext, RunnerEvent } from '../../shared/types'

// 事件类型与 cockpit-link 契约同源（@shared/types/cockpit），驾驶舱 HostClient 直接消费
export type { RunnerEvent }

export interface TaskInput {
  id: string
  task: string
  mode: string
  workspace: string
  baseUrl: string
  apiKey: string
  model: string
  /** 桌面 API 总线 — 提供时注册 desktop 工具（阶段 2 纯 API 零截图路径） */
  desktopBus?: DesktopBus
  signal: AbortSignal
  onEvent: (e: RunnerEvent) => void
  /** ask 类工具的审批回调（server 侧实现超时与广播） */
  approval: (tool: string, summary: string) => Promise<boolean>
}

export interface TaskOutput {
  status: 'completed' | 'failed' | 'cancelled'
  result: string
  error?: string
}

/** 主机可移植工具域 — 与 lazy-registry 的模块组一一对应 */
export const HOST_TOOL_GROUPS = [
  'file_system', 'terminal', 'git', 'web_intelligence', 'memory', 'skill', 'vision',
  // 代码质量 — 主机默认 coding 模式，无此组则无法 lint/格式化/依赖检查/项目索引
  // （全组零 electron import，纯 Node 可移植）
  'code_quality', 'code_review',
]

const HOST_TOOL_NAMES = [
  // file_system
  'file_read', 'file_write', 'file_list', 'file_search', 'file_edit', 'file_delete',
  'multi_edit', 'move_file', 'todo_write',
  // terminal / git
  'terminal_exec', 'git_operations',
  // web_intelligence
  'web_search', 'web_fetch', 'web_cache', 'web_research',
  // memory
  'memory_update', 'knowledge',
  // skill
  'skill_record', 'skill_invoke', 'agent_expert', 'create_tool',
  // vision — 配套 desktop 截图：Agent 截屏后据此理解画面内容
  'vision_analyze',
  // code_quality — 代码执行/检查/格式化/依赖/项目上下文与索引
  'code_execute', 'code_lint', 'code_format', 'dependency_check',
  'project_context', 'project_index',
  // code_review — 代码审查
  'code_review',
]

export { HOST_TOOL_NAMES }

const ORIGINAL_CWD = process.cwd()

function argsSummary(args: unknown): string {
  if (typeof args !== 'object' || args === null) return ''
  return Object.entries(args as Record<string, unknown>)
    .slice(0, 3)
    .map(([k, v]) => `${k}: ${typeof v === 'string' ? v.slice(0, 60) : JSON.stringify(v)?.slice(0, 60)}`)
    .join(', ')
}

// settings 引导 — 把主机配置写进主应用 settings（provider 解析由此走通），只写一次
// 返回已加载设置：vision 配置等非主机专属字段沿用主应用默认值（如免费视觉模型）
let settingsReady: Promise<AppSettings> | null = null
function ensureSettings(cfg: { baseUrl: string; apiKey: string; model: string }): Promise<AppSettings> {
  settingsReady ??= (async () => {
    const s = await loadSettings()
    if (s.apiKey !== cfg.apiKey || s.baseUrl !== cfg.baseUrl || s.model !== cfg.model) {
      const next = { ...s, apiKey: cfg.apiKey, baseUrl: cfg.baseUrl, model: cfg.model as ModelId }
      await saveSettings(next)
      return next
    }
    return s
  })().catch((e) => { settingsReady = null; throw e })
  return settingsReady
}

export async function runTask(input: TaskInput): Promise<TaskOutput> {
  process.chdir(input.workspace)
  setAllowedWriteRoots([input.workspace])

  let result = ''
  let failedError: string | undefined

  try {
    const settings = await ensureSettings({ baseUrl: input.baseUrl, apiKey: input.apiKey, model: input.model })
    await ensureModuleGroupsLoaded(HOST_TOOL_GROUPS)

    // desktop 工具 — 总线可用时注册并纳入工具清单（每次运行覆盖注册，保持单例一致）
    const toolNames = [...HOST_TOOL_NAMES]
    if (input.desktopBus?.enabled) {
      toolRegistry.register(new DesktopBusTool(input.desktopBus))
      toolNames.push('desktop')
    }
    // office 文档工具 — 零依赖 OOXML 读写（主应用 OfficeDocsTool 依赖 Windows
    // officecli.exe，Linux 主机不可用；此处走 python 标准库 helper）
    toolRegistry.register(new OfficeDocsTool())
    toolNames.push('office_docs')

    const request: ChatRequest = {
      mode: input.mode as Mode,
      model: input.model as ModelId,
      thinkingMode: true,
      reasoningEffort: 'high',
      temperature: 0.7,
      maxTokens: 8192,
      messages: [{ role: 'user', content: input.task }] as ApiMessage[],
      tools: toolRegistry.getByNames(toolNames).map(t => t.definition),
      sessionId: input.id,
      autoModeLevel: 'off', // ask 类操作 → requestConfirmation → 驾驶舱审批
    }

    const handlers = {
      onChunk: (chunk: StreamChunk): void => {
        if (chunk.content) {
          result += chunk.content
          input.onEvent({ type: 'text', text: chunk.content })
        }
        if (chunk.toolCall) {
          input.onEvent({ type: 'tool', name: chunk.toolCall.name, argsSummary: argsSummary(chunk.toolCall.arguments) })
        }
        if (chunk.toolResult) {
          input.onEvent({
            type: 'tool_result',
            name: chunk.toolResult.toolName ?? '',
            content: (chunk.toolResult.success
              ? chunk.toolResult.content
              : `失败：${chunk.toolResult.error ?? '未知错误'}`).slice(0, 2000),
            success: chunk.toolResult.success ?? false,
          })
        }
        if (chunk.done && chunk.error) failedError = chunk.error
      },
      signal: input.signal,
      requestConfirmation: (toolName: string, message: string): Promise<boolean> => input.approval(toolName, message),
      autoModeLevel: 'off' as const,
    }

    const toolContext: ToolContext = {
      apiKey: input.apiKey,
      baseUrl: input.baseUrl,
      model: input.model,
      reasoningEffort: 'high',
      terminalTimeout: 120,
      terminalOutputLimit: 50_000,
      codeExecTimeout: 60,
      webFetchMaxLength: 8000,
      webCacheEnabled: true,
      helperCommandTimeout: 30,
      mcpConnectTimeout: 30,
      visionApiKey: settings.visionApiKey ?? '',
      visionBaseUrl: settings.visionBaseUrl ?? 'https://api.agnes-ai.cn/v1',
      visionModel: settings.visionModel ?? 'agnes-2.5-flash',
      mode: input.mode as Mode,
    }

    await agentLoop(input.apiKey, input.baseUrl, request, handlers, toolContext, input.id)

    if (input.signal.aborted) return { status: 'cancelled', result: '' }
    if (failedError) return { status: 'failed', result, error: failedError }
    return { status: 'completed', result: result || '(无输出)' }
  } catch (e) {
    if (input.signal.aborted) return { status: 'cancelled', result: '' }
    return { status: 'failed', result, error: (e as Error).message.slice(0, 300) }
  } finally {
    try { process.chdir(ORIGINAL_CWD) } catch { /* 目录可能已被清理 */ }
    setAllowedWriteRoots([])
  }
}
