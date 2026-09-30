// ── 有序事件流 → 过程项 ────────────────────────────────────────────────
// 把 StreamingSegment[].events（真实发生顺序）转成按序交错排列的过程项；
// 扁平侧数据（streamingToolCalls / msg.toolCalls+toolResults）负责状态与结果。
// 从 transcriptAdapter 拆出：无状态纯函数。

import type { ToolResult, StreamingSegment } from '@shared/types'
import type { TranscriptItem, ToolItem, AssistantItem } from '@renderer/lib/transcriptTypes'
import { isReadOnlyTool, isShellTool, summarizeToolResult } from './toolMeta'

/**
 * 把「有序事件流」转成按真实发生顺序排列的过程项。
 *
 * 为什么需要它：流式和持久化的**扁平数据都是同类型堆叠**的 ——
 * `streamingReasoning` 是所有轮次推理拼成的一个大字符串、`streamingToolCalls`
 * 是全部工具调用一个数组；持久化侧的 `reasoningContent` + `toolCalls` 同理。
 * 按这两份数据渲染，只能得到「先一大段推理，再把所有工具框堆在最后」。
 *
 * 而 `StreamingSegment.events` 恰好记录了**真实发生顺序**
 * （类型注释原话：「按实际发生顺序记录，渲染时按序输出而非同类型堆叠」），
 * **流式与持久化两侧都有**，所以两侧都改用它 —— 这样一轮任务在
 * 「进行中」和「结束后」看到的顺序完全一致，不会跑完就跳回底部。
 *
 * 没有 events 的老数据退回同类型堆叠，保证不丢内容。
 *
 * @param flat 扁平侧的工具数据 —— **状态与结果的权威来源**。
 *   事件流里的 `status` 可能滞后（例如按工具名兜底匹配时漏更新事件），
 *   而扁平数组（streamingToolCalls / msg.toolCalls+toolResults）是同步维护的。
 *   两者按 toolCallId 对齐，事件负责**顺序**，扁平侧负责**状态与结果**。
 */
export function processItemsFromSegments(
  segments: StreamingSegment[],
  assistantId: string,
  flat?: {
    calls: { id: string; name: string; args: string; status: string; result?: string }[]
    results: ToolResult[]
  },
): TranscriptItem[] {
  const out: TranscriptItem[] = []
  /** 最后一个 reasoning 项 —— 若事件流的末尾仍是 reasoning，它就是"正在写"的那一段 */
  let lastReasoningId: string | null = null
  let lastEventType: string | null = null

  const flatById = new Map<string, { id: string; name: string; args: string; status: string; result?: string }>()
  for (const c of flat?.calls ?? []) if (c.id) flatById.set(c.id, c)
  const resultById = new Map<string, ToolResult>()
  for (const r of flat?.results ?? []) resultById.set(r.toolCallId, r)

  /** 用事件（定顺序）+ 扁平数据（定状态与结果）合成一条工具项 */
  const buildToolItem = (
    id: string,
    evName: string,
    evArgs: string,
    evResult: string | undefined,
    evCalling: boolean,
  ): ToolItem => {
    const info = flatById.get(id)
    const res = resultById.get(id)
    const name = info?.name || evName
    const args = info?.args || evArgs
    const output = res?.content ?? info?.result ?? evResult
    // 扁平侧有状态就以它为准（它是同步维护的），否则退回事件里的 calling/done
    const calling = info ? info.status === 'calling' || info.status === 'thinking' : evCalling
    const isErr = Boolean(res && !res.success)
    return {
      kind: 'tool',
      id,
      name,
      args,
      readOnly: isReadOnlyTool(name),
      status: calling ? 'running' : isErr ? 'error' : 'done',
      output,
      error: res?.error,
      summary: summarizeToolResult(name, args, output),
      isShell: isShellTool(name),
    } as ToolItem
  }

  for (let si = 0; si < segments.length; si++) {
    const seg = segments[si]
    const events = seg.events
    // 防御：segment 来自持久化数据时字段可能缺失，缺字段不该让整块过程渲染不出来
    const segTools = seg.toolCalls ?? []

    if (!events || events.length === 0) {
      if (seg.reasoning?.trim()) {
        const id = `${assistantId}-r${si}`
        out.push({
          kind: 'assistant', id, text: '', reasoning: seg.reasoning,
          streaming: false, reasoningComplete: true,
        } as AssistantItem)
        lastReasoningId = id
      }
      for (let ti = 0; ti < segTools.length; ti++) {
        const tc = segTools[ti]
        const id = tc.toolCallId ?? `${assistantId}-t${si}-${ti}`
        out.push(buildToolItem(id, tc.name, tc.args ?? '', tc.result, tc.status === 'calling' || tc.status === 'thinking'))
      }
      if (segTools.length > 0) lastEventType = 'tool'
      continue
    }

    for (let ei = 0; ei < events.length; ei++) {
      const ev = events[ei]
      if (ev.type === 'reasoning') {
        if (!ev.text?.trim()) continue
        const id = `${assistantId}-r${si}-${ei}`
        out.push({
          kind: 'assistant', id, text: '', reasoning: ev.text,
          streaming: false, reasoningComplete: true,
        } as AssistantItem)
        lastReasoningId = id
        lastEventType = 'reasoning'
      } else if (ev.type === 'tool') {
        out.push(buildToolItem(
          ev.toolCallId ?? `${assistantId}-t${si}-${ei}`,
          ev.toolName ?? '',
          ev.args ?? '',
          ev.result,
          ev.status === 'calling',
        ))
        lastEventType = 'tool'
      }
      // content 事件是最终回答，不属于过程区，跳过
    }
  }

  // 事件流末尾仍是 reasoning ⇒ 模型此刻正在写思考，给它挂上"进行中"标记
  if (lastEventType === 'reasoning' && lastReasoningId) {
    const target = out.find((it) => it.id === lastReasoningId)
    if (target && target.kind === 'assistant') {
      target.streaming = true
      target.reasoningComplete = false
    }
  }

  return out
}
