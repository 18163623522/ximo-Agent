// ── 对话历史 → API 消息转换 ────────────────────────────────────────────
// buildApiMessages 的最后阶段：把 conversation.messages 重放为
// assistant/tool/user 消息序列（保留 tool_calls 配对与 reasoning_content 回传）。
// 从 buildApiMessages 拆出：无状态纯函数，结果追加进调用方传入的 messages。

import type { ApiMessage, Conversation, ReasoningEffort } from '@shared/types'
import { truncateToolResult, type AgentConfig } from '@shared/context-compress'
import { isToolPairComplete, buildInterruptedToolNote } from '@shared/tool-pair'

/**
 * 把对话历史重放为 API 消息并追加到 messages（含 system 消息过滤与 A2' 回传）
 */
export function appendHistoryMessages(
  messages: ApiMessage[],
  conversation: Conversation,
  config: AgentConfig,
  thinkingMode?: boolean,
  reasoningEffort?: ReasoningEffort
): void {
  // ── A2' reasoning_content 回传策略 ──
  // 官方约束（api-docs.deepseek.com/guides/thinking_mode）：
  // 请求携带 tools 参数时，历史里**所有** assistant 轮的 reasoning_content 都必须
  // 原样回传 —— 包括没有发生工具调用的轮次。回传不正确 = 400
  // 「The reasoning_content in the thinking mode must be passed back to the API」。
  //
  // 两条判定：
  //   1. 本次是思考模式 → 历史每个 assistant 轮都要带（没有存储值的补空串，
  //      至少保证字段存在；空串不影响 API 侧的上下文拼接）
  //   2. 本轮自身存了 reasoning → 带真实内容（思考模式中途关掉时，
  //      历史里已有的思维链仍须回传，否则下一次带 tools 的请求照样 400）
  const replayReasoning = Boolean(thinkingMode && reasoningEffort !== 'off')

  for (const msg of conversation.messages) {
    // 保留持久化的 system 消息（监督纠正等 Loop 内注入的），跳过运行时的 system 消息（记忆等）
    // 监督纠正消息以「--- 监督审查（第 X 轮）---」开头（buildCorrectionMessage 格式），
    // 主进程 Loop 内已注入 messages 末尾，重建时必须保留，否则前缀字节漂移 → 缓存 miss
    if (msg.role === 'system') {
      if (msg.content.startsWith('--- 监督审查') || msg.content.startsWith('⚠️ 审查结论') || msg.content.startsWith('## 任务意图分析结果')) {
        messages.push({ role: 'system', content: msg.content })
      }
      continue
    }

    if (msg.role === 'assistant') {
      // 如果 assistant 消息携带了工具调用，需要完整保留 tool_calls 和 tool 结果
      if (msg.toolCalls && msg.toolCalls.length > 0) {
        // 配对完整性保护：tool_calls 与 tool 结果必须一一对应，
        // 否则（流中断/部分结果丢失）放弃 tool_calls 结构，转文本说明，
        // 避免产生孤儿 tool_calls 触发 DeepSeek 400。
        if (!isToolPairComplete(msg.toolCalls, msg.toolResults)) {
          messages.push({
            role: 'assistant',
            content: (msg.content || '') + buildInterruptedToolNote(msg.toolCalls, msg.toolResults)
          })
          continue
        }
        messages.push({
          role: 'assistant',
          content: msg.content || '',
          tool_calls: msg.toolCalls.map((tc) => ({
            id: tc.id,
            type: 'function' as const,
            function: { name: tc.name, arguments: JSON.stringify(tc.arguments) }
          })),
          // A2' 回传真实 reasoning（原来是空串 —— 空串就是"思维链丢了"，直接 400）
          ...(replayReasoning || msg.reasoningContent !== undefined
            ? { reasoning_content: msg.reasoningContent ?? '' }
            : {})
        })
        // 追加每条 tool 结果作为 tool 角色消息
        // 使用 truncateToolResult 截断 — 与 Agent Loop 中的截断逻辑一致，确保缓存前缀一致
        if (msg.toolResults) {
          for (const result of msg.toolResults) {
            const rawContent = result.success ? (result.content || '') : `Error: ${result.error || '未知错误'}`
            messages.push({
              role: 'tool',
              content: truncateToolResult(rawContent, config),
              tool_call_id: result.toolCallId
            })
          }
        }
      } else {
        // 纯文本 assistant 轮 —— 同样要回传 reasoning_content。
        // 官方明确「即使是模型没有进行工具调用的轮次也要回传」，
        // 这条原先完全没带，是 400 最常见的触发点（每轮无工具回答都会留下一个缺字段的消息）
        messages.push({
          role: 'assistant',
          content: msg.content,
          ...(replayReasoning || msg.reasoningContent !== undefined
            ? { reasoning_content: msg.reasoningContent ?? '' }
            : {})
        })
      }
    } else {
      // user 消息 — 如果携带 slashCommand，将 systemHint 拼接到 content 前面发送给 API
      // systemHint 可能在旧版本持久化数据中不存在（undefined），用 ?? '' 兜底
      const userContent = msg.slashCommand ? (msg.slashCommand.systemHint ?? '') + msg.content : msg.content
      messages.push({ role: msg.role, content: userContent })
    }
  }
}
