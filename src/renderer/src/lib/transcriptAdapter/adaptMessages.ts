// ── ChatMessage[] → TranscriptItem[] 主转换 ────────────────────────────
// adaptMessages 主体：消息遍历、流式占位、工具项与回答项的编排。
// 从 transcriptAdapter 拆出：无状态纯函数。

import type { ChatMessage, ToolResult, StreamingSegment } from '@shared/types'
import type { TranscriptItem, ToolItem, AssistantItem } from '@renderer/lib/transcriptTypes'
import { isReadOnlyTool, isShellTool, summarizeToolResult } from './toolMeta'
import { processItemsFromSegments } from './orderedProcess'

/**
 * 把 ChatMessage[] 转成扁平的 TranscriptItem[]
 *
 * 转换规则：
 * - user 消息 → user item
 * - assistant 消息 → 如果有 reasoning，先输出一个 reasoning-only assistant item
 *                    如果有 text，再输出一个 answer assistant item
 * - toolCalls → 每个变成独立的 tool item (status=done)
 * - toolResults → 匹配到对应 tool item 并补充 output
 * - 流式：优先用 streamingSegments[].events 的**真实顺序**交错输出；
 *        没有 events 时退回"reasoning 一段 + 工具追加在末尾"
 * - 流式占位消息 → 即使 content/reasoning 都为空，也输出一个 streaming assistant item
 */
export function adaptMessages(
  messages: ChatMessage[],
  streamingToolCalls?: { name: string; status: 'thinking' | 'calling' | 'done'; args?: string; result?: string; toolCallId?: string }[],
  streamingAssistantId?: string | null,
  streamingSegments?: StreamingSegment[],
): TranscriptItem[] {
  const items: TranscriptItem[] = []
  let seq = 0

  for (const msg of messages) {
    if (msg.role === 'user') {
      items.push({
        kind: 'user',
        id: msg.id,
        text: msg.content,
        timestamp: msg.timestamp,
        slashCommand: msg.slashCommand,
      })
      continue
    }

    if (msg.role === 'assistant') {
      const hasReasoning = Boolean(msg.reasoningContent?.trim())
      const hasText = Boolean(msg.content?.trim())
      const isStreamingPlaceholder = streamingAssistantId === msg.id

      // 优先走「有序事件流」—— 让推理与工具按真实发生顺序交错，
      // 而不是"推理一大段 + 工具全堆在末尾"。
      //
      // **流式与持久化两侧都要走**：只修流式的话，任务一结束就切回持久化路径，
      // 工具会整体跳回底部 —— 表现成"跑完又跑回底部了"。
      //
      // ⚠️ 必须**只有在它真能产出内容时**才采信：events 里可能只有 content 事件
      //（没有 reasoning / tool），此时有序路径产出 0 项。若无条件采信，就会
      // 同时跳过下面的 reasoning 兜底与末尾的工具追加 —— 结果是整块过程**全部不可见**，
      // 表现为"一直正在思考、不出内容"。
      const orderedSource = isStreamingPlaceholder
        ? (streamingSegments?.some((s) => s.events?.length) ? streamingSegments : null)
        : (msg.segments?.some((s) => s.events?.length) ? msg.segments : null)
      const orderedProcess = orderedSource
        ? processItemsFromSegments(orderedSource, msg.id, {
            // 流式侧用 streamingToolCalls 的实时状态，持久化侧用 msg 上的记录 ——
            // 两者都是同步维护的，作为状态与结果的权威
            calls: isStreamingPlaceholder
              ? (streamingToolCalls ?? []).map((tc) => ({
                  id: tc.toolCallId ?? '', name: tc.name, args: tc.args ?? '', status: tc.status, result: tc.result,
                }))
              : (msg.toolCalls ?? []).map((tc) => ({
                  id: tc.id, name: tc.name, args: JSON.stringify(tc.arguments), status: 'done',
                })),
            results: msg.toolResults ?? [],
          })
        : null
      const useOrdered = Boolean(orderedProcess && orderedProcess.length > 0)
      if (useOrdered && orderedProcess) {
        for (const it of orderedProcess) items.push(it)
      } else if (hasReasoning) {
        // reasoning 作为过程材料独立输出（无论是否有 text）
        items.push({
          kind: 'assistant',
          id: `${msg.id}-r`,
          text: '',
          reasoning: msg.reasoningContent!,
          streaming: false,
          reasoningComplete: true,
        })
      }

      // 工具调用 → 独立 tool items
      // 走有序事件流时跳过 —— 那些工具已经按真实顺序插在推理之间了（否则会渲染两遍）
      if (msg.toolCalls && !useOrdered) {
        const resultMap = new Map<string, ToolResult>()
        if (msg.toolResults) {
          for (const tr of msg.toolResults) {
            resultMap.set(tr.toolCallId, tr)
          }
        }

        for (const tc of msg.toolCalls) {
          const result = resultMap.get(tc.id)
          const argsStr = JSON.stringify(tc.arguments)
          const isErr = result && !result.success
          items.push({
            kind: 'tool',
            id: tc.id,
            name: tc.name,
            args: argsStr,
            readOnly: isReadOnlyTool(tc.name),
            status: result ? (isErr ? 'error' : 'done') : 'done',
            output: result?.content,
            error: result?.error,
            summary: summarizeToolResult(tc.name, argsStr, result?.content),
            isShell: isShellTool(tc.name),
          } as ToolItem)
        }
      }

      // text 作为回答 assistant item
      if (hasText) {
        items.push({
          kind: 'assistant',
          id: msg.id,
          text: msg.content,
          reasoning: '',
          streaming: false,
          reasoningComplete: true,
          model: msg.model,
        } as AssistantItem)
      } else if (isStreamingPlaceholder) {
        // 流式占位消息：content 和 reasoning 都为空，但仍需输出一个 streaming assistant item
        // 这样 live 数据才能通过 id 匹配注入
        items.push({
          kind: 'assistant',
          id: msg.id,
          text: '',
          reasoning: '',
          streaming: true,
          reasoningComplete: false,
          // 有序流里推理已经输出过了 —— 这一项只用来承接正文，不要再吃 live.reasoning
          ...(useOrdered ? { liveTextOnly: true } : {}),
        } as AssistantItem)
      }
      continue
    }
  }

  // 追加流式中的 tool items — 包括正在执行和已完成的
  // 已完成的工具调用在持久化前不会出现在 msg.toolCalls 中，
  // 必须在此处渲染，否则工具一旦完成就从 UI 消失。
  //
  // 走有序事件流时，工具已经按真实顺序插在推理之间了；这里按 **toolCallId 去重**后
  // 只补事件流里没有的那些 —— 而不是整个跳过。
  // 原因：events 有可能不完整（某一轮没写事件），一刀跳过会让那几件工具**彻底消失**；
  // 去重补漏则保证"顺序尽量对，且一个都不丢"。
  if (streamingToolCalls) {
    const alreadyEmitted = new Set(
      items.flatMap((it) => (it.kind === 'tool' ? [it.id] : [])),
    )
    for (const stc of streamingToolCalls) {
      const id = stc.toolCallId || `streaming-tool-${seq++}`
      if (alreadyEmitted.has(id)) continue
      const isRunning = stc.status === 'calling' || stc.status === 'thinking'
      items.push({
        kind: 'tool',
        id,
        name: stc.name,
        args: stc.args || '',
        readOnly: isReadOnlyTool(stc.name),
        status: isRunning ? 'running' : 'done',
        output: stc.result,
        // 与持久化路径走同一个摘要函数 —— 否则流式期间显示的是输出原文，
        // 刷新后变成结构化摘要，同一行工具前后长得不一样
        summary: stc.result ? summarizeToolResult(stc.name, stc.args || '', stc.result) : undefined,
        isShell: isShellTool(stc.name),
      } as ToolItem)
    }
  }

  return items
}
