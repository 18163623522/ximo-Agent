import type { ToolCall, ToolResult, StreamChunk, ToolContext } from '@shared/types'
import { toolRegistry } from '@main/tools/ToolRegistry'
import { toApiEffort } from '@main/deepseek/api'
import { agentConfig } from '@main/deepseek/context'
import { evaluate, extractSubject, getConfigForMode, YOLO_CONFIG, SAFE_CONFIG, type PermissionConfig } from '@main/Permission'
import { isPreviouslyRejected, rememberRejected } from '@main/deepseek/tool-permissions'
import { ContextManager, compactWithSummary, type MutableMessage } from '@shared/cache'
import { MAX_SUB_AGENT_ROUNDS, MAX_SUB_TOOL_RESULT } from './expert-config'

interface SubMessage {
  role: string
  content: string
  tool_calls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }>
  tool_call_id?: string
}

/** 子 Agent 禁用的工具 — 防递归套娃（子 Agent 不得再召唤子 Agent） */
const FORBIDDEN_SUB_TOOLS = new Set(['agent_expert'])

/** 子 Agent 权限配置解析 — 与主链路 tool-permissions.ts:34-38 同构（同规则源、同优先级） */
function resolveSubAgentPermConfig(context: ToolContext): PermissionConfig {
  if (context.autoModeLevel === 'yolo') return YOLO_CONFIG
  if (context.autoModeLevel === 'safe') return SAFE_CONFIG
  return getConfigForMode(context.mode ?? 'coding')
}

/**
 * 调用子 Agent（带工具调用能力）
 *
 * 与主 Agent Loop 类似但更精简：
 * - 非流式调用（子 Agent 不需要流式输出到前端）
 * - 通过 onChunk 推送工具执行状态 + 专家工作过程事件（subAgentEvent），供前端实时可视化
 * - 支持多轮工具调用直到子 Agent 给出最终回答
 *
 * 导出供 SkillInvokeTool 调用 expert 类型技能时复用
 */
export async function callSubAgentWithTools(
  context: ToolContext,
  systemPrompt: string,
  task: string,
  toolNames: string[],
  onChunk?: (chunk: StreamChunk) => void,
  signal?: AbortSignal,
  eventSink?: (event: NonNullable<StreamChunk['subAgentEvent']>) => void,
  expertInfo?: { expertId: string; expertName: string }
): Promise<string> {
  const url = `${context.baseUrl.replace(/\/$/, '')}/chat/completions`
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), (context.subAgentTimeout ?? 120) * 1000)
  if (signal) signal.addEventListener('abort', () => controller.abort(), { once: true })

  // 从注册表获取工具实例和定义 — 剥离禁用工具（agent_expert），双保险：
  // ① toolDefs 由 toolInstances 生成，LLM 根本看不到被剥离的工具，正常情况下不会调用
  // ② 若 LLM 幻觉调用，下方 toolInstances.find 找不到 → 返回"工具未注册"
  const toolInstances = toolNames
    .map(name => toolRegistry.get(name))
    .filter((t): t is NonNullable<typeof t> => t !== undefined && !FORBIDDEN_SUB_TOOLS.has(t.definition.name))

  const toolDefs = toolInstances.map(t => ({
    type: 'function' as const,
    function: { name: t.definition.name, description: t.definition.description, parameters: t.definition.parameters }
  }))

  const messages: SubMessage[] = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: task }
  ]

  // 记忆管家 — 复用主 Agent 的四档压缩（ContextManager），按服务商窗口阈值触发，
  // 防止子 Agent 长任务（15 轮 × 8000 字符工具结果）撑爆小窗口服务商的上下文
  const ctxManager = new ContextManager()

  // 专家身份信息 — 优先使用调用方显式传入；降级从系统提示词解析
  // buildExpertSystemPrompt 格式：'你现在扮演 **{name}**（{emoji}）。'
  const expertIdMatch = expertInfo?.expertId ?? systemPrompt.match(/你现在扮演 \*\*[^*]+\*\*（([^）]+)）/)?.[1] ?? 'unknown-expert'
  const expertName = expertInfo?.expertName ?? systemPrompt.match(/你现在扮演 \*\*([^*]+)\*\*/)?.[1] ?? expertIdMatch
  const expertEmoji = systemPrompt.match(/你现在扮演 \*\*[^*]+\*\*（([^）]+)）/)?.[1] ?? '🧠'

  /** 推送专家工作过程事件 */
  const pushEvent = (stage: 'started' | 'tool' | 'toolResult' | 'message' | 'finished', detail?: string, toolArgs?: string, result?: string): void => {
    const event = {
      expertId: expertIdMatch,
      expertName,
      stage,
      taskSummary: task.slice(0, 120),
      detail,
      toolArgs,
      result,
    }
    onChunk?.({ subAgentEvent: event })
    eventSink?.(event)
  }

  try {
    // 专家开始工作
    pushEvent('started', `专家开始处理任务：${task.slice(0, 100)}`)

    for (let round = 0; round < MAX_SUB_AGENT_ROUNDS; round++) {
      if (controller.signal.aborted) break

      const body: Record<string, unknown> = {
        model: context.subAgentModel ?? context.model,
        messages,
        stream: false,
        max_tokens: context.subAgentMaxTokens ?? 8192,
        ...(toolDefs.length > 0 ? { tools: toolDefs, tool_choice: 'auto' } : {}),
        ...(context.subAgentReasoningEffort && context.subAgentReasoningEffort !== 'off'
          ? { enable_thinking: true, reasoning_effort: toApiEffort(context.subAgentReasoningEffort) }
          : { temperature: context.subAgentTemperature ?? 0.7 })
      }

      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${context.apiKey}` },
        body: JSON.stringify(body),
        signal: controller.signal
      })

      if (!response.ok) {
        const errText = await response.text().catch(() => '')
        throw new Error(`子 Agent API 调用失败 (${response.status}): ${errText}`)
      }

      const data = await response.json()
      const msg = data.choices?.[0]?.message

      // 上下文压缩 — 读取本轮 usage，复用主 Agent 四档压缩（soft 通知 / snip 裁剪 / compact+force LLM 摘要）
      // 阈值取 agentConfig.contextWindow（与主 Agent 同服务商同窗口），1M 大窗口下自然不触发，小窗口自动生效
      const promptTokens = data.usage?.prompt_tokens ?? 0
      if (promptTokens > 0 && !controller.signal.aborted) {
        const compactStats = ctxManager.maybeCompact({
          messages: messages as MutableMessage[],
          config: {
            maxToolResultChars: agentConfig.maxToolResultChars,
            maxContextChars: agentConfig.maxContextChars,
            recentKeep: agentConfig.recentKeep,
            snippedKeep: agentConfig.snippedKeep,
            prunedKeep: agentConfig.prunedKeep
          },
          promptTokens,
          contextWindow: agentConfig.contextWindow,
          compactionRatio: agentConfig.compactionRatio
        })
        if (compactStats.tier === 'compact' || compactStats.tier === 'force') {
          await compactWithSummary(
            context.apiKey, context.baseUrl, context.subAgentModel ?? context.model,
            messages as MutableMessage[], agentConfig.contextWindow, agentConfig.recentKeep, controller.signal
          )
        }
      }

      // 无工具调用 → 返回最终回答
      if (!msg?.tool_calls || msg.tool_calls.length === 0) {
        const finalContent = msg?.content || '(子 Agent 未返回内容)'
        pushEvent('finished', '专家已完成任务，返回最终结果', undefined, finalContent)
        return finalContent
      }

      // 有工具调用 → 执行工具并继续循环
      messages.push({
        role: 'assistant',
        content: msg.content || '',
        tool_calls: msg.tool_calls
      })

      // 专家中间思考产出（若存在）
      if (msg.content && msg.content.trim()) {
        pushEvent('message', msg.content.trim().slice(0, 300))
      }

      // 逐个执行工具调用
      for (const tc of msg.tool_calls) {
        const toolName = tc.function.name
        const subAgentDisplayName = `${toolName}（子Agent）`
        let args: Record<string, unknown> = {}
        try { args = JSON.parse(tc.function.arguments) } catch { /* keep empty */ }

        // ── 权限检查 — 与主链路（tool-execution.ts → checkPermissions）同规则源 ──
        // 此前子 Agent 直接执行工具绕过了审批闸门；此处补齐同样的决策：
        //   deny → 拒绝；ask → 弹窗确认（拒绝后写入会话级缓存，无确认渠道时 fail-closed 拒绝）
        // 文案与主链路 tool-permissions.ts 严格一致（错误文案会进入 API 消息前缀，不可漂移）
        const permDecision = evaluate(resolveSubAgentPermConfig(context), toolName, extractSubject(toolName, args))
        if (permDecision !== 'allow') {
          let denialReason: string
          let shouldRemember = false
          if (permDecision === 'deny') {
            denialReason = '权限拒绝：该工具在当前模式下不可用'
          } else if (isPreviouslyRejected(toolName, args)) {
            denialReason = '用户此前已拒绝此操作（本次会话内不再询问）'
          } else if (context.requestConfirmation) {
            const toolLabel = toolName.replace(/_/g, ' ')
            const argSummary = Object.entries(args)
              .slice(0, 3)
              .map(([k, v]) => `${k}: ${typeof v === 'string' ? v.slice(0, 60) : JSON.stringify(v)?.slice(0, 60)}`)
              .join(', ')
            const confirmed = await context.requestConfirmation(toolName, `工具: ${toolLabel}\n参数: ${argSummary || '(无)'}`)
            if (confirmed) {
              // 用户确认放行 — denialReason 置空，落到下方正常执行逻辑
              denialReason = ''
            } else {
              shouldRemember = true
              denialReason = '用户取消了此操作'
            }
          } else {
            denialReason = '无法确认操作：未提供确认回调，出于安全考虑拒绝执行'
          }

          if (denialReason) {
            if (shouldRemember) rememberRejected(toolName, args)
            const deniedResult: ToolResult = {
              toolCallId: tc.id, toolName, content: '', success: false, error: denialReason
            }
            onChunk?.({ toolResult: deniedResult, toolStatus: 'done', toolName: subAgentDisplayName })
            pushEvent('toolResult', `权限拦截：${denialReason}`)
            // 保持 tool_calls 配对完整 — 缺 tool 结果消息会导致下一轮 API 400
            messages.push({ role: 'tool', content: `Error: ${denialReason}`, tool_call_id: tc.id })
            continue
          }
        }

        const subAgentToolCall: ToolCall = { id: tc.id, name: subAgentDisplayName, arguments: args }
        onChunk?.({ toolStatus: 'calling', toolName: subAgentDisplayName, toolCall: subAgentToolCall })

        // 推送专家工具调用事件
        const argsSummary = Object.entries(args).slice(0, 3).map(([k, v]) => `${k}: ${typeof v === 'string' ? v.slice(0, 80) : JSON.stringify(v)?.slice(0, 80)}`).join(', ')
        pushEvent('tool', `调用工具 ${toolName}`, argsSummary || '(无参数)')

        const tool = toolInstances.find(t => t.definition.name === toolName)
        let result: ToolResult
        if (tool) {
          const toolCallObj: ToolCall = { id: tc.id, name: toolName, arguments: args }
          try {
            result = await tool.execute(toolCallObj, onChunk, controller.signal, context)
          } catch (e) {
            result = {
              toolCallId: tc.id, toolName, content: `工具执行出错：${(e as Error).message}`,
              success: false, error: (e as Error).message
            }
          }
        } else {
          result = {
            toolCallId: tc.id, toolName,
            content: `工具 ${toolName} 未注册，无法执行`,
            success: false, error: '工具未注册'
          }
        }

        // 推送专家工具结果事件
        const resultSummary = result.success
          ? (result.content?.slice(0, 150) || '执行成功')
          : `执行失败：${result.error || '未知错误'}`
        pushEvent('toolResult', resultSummary)

        // 覆盖 toolName 为子 Agent 显示名，确保与 calling chunk 的名称一致
        const subAgentResult: ToolResult = { ...result, toolName: subAgentDisplayName }
        onChunk?.({ toolResult: subAgentResult, toolStatus: 'done', toolName: subAgentDisplayName })

        // 截断超长结果防止上下文溢出
        const truncated = result.content.length > MAX_SUB_TOOL_RESULT
          ? result.content.slice(0, MAX_SUB_TOOL_RESULT) + '\n[...子 Agent 结果已截断]'
          : result.content

        messages.push({ role: 'tool', content: truncated, tool_call_id: tc.id })
      }
    }

    // 达到最大轮次，请求最终总结
    pushEvent('message', '已达最大工具调用轮次，正在生成最终总结…')
    messages.push({
      role: 'user',
      content: '你已经完成了所有工具调用。请基于已有信息直接给出最终回答，不要再调用任何工具。'
    })

    const finalBody: Record<string, unknown> = {
      model: context.subAgentModel ?? context.model,
      messages,
      stream: false,
      max_tokens: context.subAgentMaxTokens ?? 8192,
      ...(context.subAgentReasoningEffort && context.subAgentReasoningEffort !== 'off'
        ? { enable_thinking: true, reasoning_effort: toApiEffort(context.subAgentReasoningEffort) }
        : { temperature: context.subAgentTemperature ?? 0.7 })
    }

    const finalResponse = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${context.apiKey}` },
      body: JSON.stringify(finalBody),
      signal: controller.signal
    })

    if (!finalResponse.ok) {
      pushEvent('finished', '专家最终总结请求失败')
      return '(子 Agent 达到最大工具调用轮次，且最终总结请求失败)'
    }

    const finalData = await finalResponse.json()
    const finalContent = finalData.choices?.[0]?.message?.content || '(子 Agent 未返回最终内容)'
    pushEvent('finished', '专家已完成任务，返回最终结果', undefined, finalContent)
    return finalContent
  } finally {
    clearTimeout(timeout)
  }
}
