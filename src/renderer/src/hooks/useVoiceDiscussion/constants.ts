/** 语音讨论 — 对外类型与内置常量（自 useVoiceDiscussion.ts 拆出，经门面 re-export） */

export type DiscussionState = 'idle' | 'listening' | 'transcribing' | 'speaking'

/** 内置讨论提示词（设置中留空时使用） */
export const DEFAULT_DISCUSSION_PROMPT =
  '你是用户的语音讨论伙伴。正在通过语音讨论任务方案。回复规则：极简口语化，不超过两句话，直接回答核心问题，不用列表/代码/标题。'

/** 单次回复长度上限默认值 */
export const DEFAULT_DISCUSSION_MAX_TOKENS = 2048
