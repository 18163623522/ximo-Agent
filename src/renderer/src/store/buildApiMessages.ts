// ── 发送给 API 的消息列表构建（编排入口）────────────────────────────────
// 实现按构建阶段拆分在同目录 buildApiMessages/ 子文件夹：
//   caches.ts       — 导入技能/模式记忆缓存（唯一的可变状态模块）
//   systemPrompt.ts — 系统提示词组装
//   history.ts      — 对话历史转换
// 此处保留原路径导出与编排逻辑。

import type { ApiMessage, Conversation, ReasoningEffort } from '@shared/types'
import type { AgentConfig } from '@shared/context-compress'
import { buildSystemContent } from './buildApiMessages/systemPrompt'
import { appendHistoryMessages } from './buildApiMessages/history'

export { invalidateImportedSkillsCache, invalidateMemoryCache } from './buildApiMessages/caches'

/** 默认上下文配置 — 与 deepseek.ts 中 agentConfig 默认值保持一致 */
const DEFAULT_CONFIG: AgentConfig = {
  maxToolResultChars: 8000,
  maxContextChars: 300000,
  recentKeep: 5,
  snippedKeep: 200,
  prunedKeep: 80
}

/**
 * 构造发送给 API 的消息列表（含系统提示）
 * 关键：保留 tool_calls / tool 结果，让 LLM 在多轮对话中记住之前的操作
 *
 * A2' reasoning_content：思考模式下历史 assistant 轮的思维链必须原样回传，
 * 否则带 tools 的请求会被 DeepSeek 以 400 拒绝。详见下方 replayReasoning 注释。
 *
 * 缓存优化策略（按稳定性分层前缀）：
 * DeepSeek prompt 缓存基于前缀匹配——Turn N+1 的消息列表必须是 Turn N 的严格扩展，
 * 否则前缀断裂处之后的所有 token 都变为未命中。
 *
 * 消息列表按「稳定性递减」排列，确保高稳定内容始终命中缓存：
 *   [0] system — 稳定系统提示词（模式提示词+自定义指令+专家人格+项目路径+技能，~25KB+）
 *   [1] system — 运行环境信息（日期级，同一天内不变）
 *   [2] system — 运行时工具状态（浏览器/操控电脑开关，偶尔变化）
 *   [3] system — 模式记忆（Agent 调用 memory_update 时变化，偶尔发生）
 *   [4+] 对话历史（每轮追加，天然扩展）
 *
 * 关键：记忆从 systemContent 中拆出为独立消息，避免 memory_update 后
 *       整个 25KB+ 系统提示词（含专家提示词）缓存全部失效。
 */
export async function buildApiMessages(
  conversation: Conversation,
  customPrompt?: string,
  activeExpertIds?: string[],
  orchestratorEnforce?: boolean,
  browserOpen?: boolean,
  computerUseRunning?: boolean,
  activeStyleId?: string | null,
  mainAgentCustomPrompt?: string,
  mainAgentExpertId?: string,
  contextConfig?: Partial<AgentConfig>,
  reasoningEffort?: ReasoningEffort,
  memoryEnabled?: boolean,
  thinkingMode?: boolean
): Promise<ApiMessage[]> {
  // 合并上下文配置
  const config: AgentConfig = { ...DEFAULT_CONFIG, ...contextConfig }

  // 系统提示词、运行时状态行、模式记忆 — 组装细节见 ./buildApiMessages/systemPrompt
  const { systemContent, runtimeStatusLines, memoryContent } = await buildSystemContent({
    conversation,
    customPrompt,
    activeExpertIds,
    orchestratorEnforce,
    computerUseRunning,
    activeStyleId,
    mainAgentCustomPrompt,
    mainAgentExpertId,
    reasoningEffort,
    memoryEnabled
  })

  const messages: ApiMessage[] = [
    { role: 'system', content: systemContent }
  ]

  // 运行时工具状态紧随 system prompt，作为稳定前缀的一部分
  // 放在前缀位置而非末尾：避免新对话消息插入时后缀位置偏移导致缓存前缀断裂
  if (runtimeStatusLines.length > 0) {
    messages.push({
      role: 'system',
      content: `--- 后台工具状态 ---\n${runtimeStatusLines.join('\n')}`
    })
  }

  // 模式记忆作为独立 system 消息 — 放在稳定前缀之后、对话历史之前
  // 稳定性低于系统提示词（memory_update 会修改），但高于对话历史（不会每轮都变）
  if (memoryContent) {
    messages.push({
      role: 'system',
      content: `--- 记忆 ---\n${memoryContent}`
    })
  }

  // 对话历史重放（tool_calls / tool 结果保留 + reasoning_content 回传）
  appendHistoryMessages(messages, conversation, config, thinkingMode, reasoningEffort)

  // ── 缓存稳定性关键：此处不调用 trimContext ──
  // trimContext 使用 protectFrom = messages.length - recentKeep 做位置截断，
  // 随对话增长 protectFrom 前移，之前受保护的全量消息变为可截断 → 内容突变 → 缓存断裂。
  // 且 buildApiMessages 每次从原始 conversation 重建（丢失上次 snip 标记），
  // 导致截断从零重做，protectFrom 漂移使不同消息被截断 → 前缀字节不一致。
  //
  // 压缩职责交给 agentLoop 内的 ContextManager.maybeCompact（基于实际 token usage），
  // maybeCompact 在同一 messages 数组上操作，snip 标记在 loop 内跨轮保持，
  // 且仅在 promptTokens ≥ 60% contextWindow（600K tokens）时才触发，
  // 远高于 trimContext 的 60% maxContextChars（180K chars ≈ 45K tokens），
  // 避免对中等长度对话做不必要的截断。
  //
  // truncateToolResult 仍在此处生效，限制单条工具结果 ≤ maxToolResultChars，
  // 防止单条超长结果爆上下文，但不做位置依赖的全局截断。
  return messages
}
