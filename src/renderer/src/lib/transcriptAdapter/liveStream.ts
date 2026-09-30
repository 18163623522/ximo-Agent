// ── 流式 LiveStream 构建 ────────────────────────────────────────────────
// 从流式数据构建 LiveStream 对象，供 UI 注入实时正文与推理。
// 从 transcriptAdapter 拆出：无状态纯函数。

import type { LiveStream } from '@renderer/lib/transcriptTypes'

/** 从流式数据构建 LiveStream — 只要 isStreaming 就返回对象，让 UI 能显示加载状态 */
export function buildLiveStream(
  assistantId: string,
  content: string,
  reasoning: string,
): LiveStream | undefined {
  return {
    id: assistantId,
    text: content,
    reasoning,
    reasoningComplete: false,
    reasoningStartedAt: reasoning ? Date.now() : undefined,
  }
}
