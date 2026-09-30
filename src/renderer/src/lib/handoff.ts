import type { Conversation } from '@shared/types'

export interface HandoffResult {
  task: string
  messageCount: number
}

/**
 * 工作交接 — 把当前对话打包为后台实例的交接任务。
 * 取近期消息作为上下文，Agent 带着完整语境接手（而不是失忆的外包）。
 */
export function buildHandoffTask(conversation: Conversation, instruction: string): HandoffResult {
  const msgs = conversation.messages.filter((m) => m.role !== 'system')
  const recent = msgs.slice(-12)
  const lines = recent.map((m) => {
    const who = m.role === 'user' ? '主人' : 'Agent'
    const content = m.content.trim().slice(0, 300) || (m.toolCalls?.length ? '（执行了工具调用）' : '')
    return `- ${who}: ${content}`
  })

  const task = [
    '[工作交接] 请接手以下对话中的任务并继续完成（原对话的主人把活儿交给你，在你自己的系统里执行）。',
    instruction.trim() ? `\n主人的交接要求：${instruction.trim()}` : '',
    `\n## 交接背景\n对话标题：${conversation.title}`,
    `\n## 近期对话内容\n${lines.join('\n')}`,
    '\n## 交接要求\n1. 先根据上文判断任务进行到哪一步\n2. 用可用工具继续完成剩余工作\n3. 完成后在最终汇报里说明：做了什么、结果在哪、还有什么没做'
  ].join('')

  return { task, messageCount: recent.length }
}
