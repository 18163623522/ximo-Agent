/**
 * work-context — 工作感知上下文
 *
 * 汇总近期对话与后台任务，作为"主人近期在忙什么"的上下文，注入 Agent 实例的 system prompt。
 */

// -----------------------------------------------------------------------
// 工作感知 — 汇总近期对话与后台任务，作为"主人近期在忙什么"的上下文
// -----------------------------------------------------------------------

import { loadConversations } from '../store'
import type { AgentInstance } from '@shared/agent-definition'

export async function buildWorkContext(instances: AgentInstance[]): Promise<string> {
  try {
    const conversations = await loadConversations()
    const weekAgo = Date.now() - 7 * 86_400_000
    // 排除实例自身的会话（标题以 [ 开头），只统计主人真实的对话
    const recent = conversations
      .filter((c) => c.updatedAt >= weekAgo && c.messages.length > 0 && !c.title.startsWith('['))
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, 8)
    const insRecent = instances.filter((i) => i.startedAt >= weekAgo).slice(0, 5)
    if (recent.length === 0 && insRecent.length === 0) return ''

    const lines = recent.map((c) => {
      const lastUser = [...c.messages].reverse().find((m) => m.role === 'user')
      const snippet = lastUser ? lastUser.content.trim().slice(0, 60) : ''
      const date = new Date(c.updatedAt).toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' })
      return `- [${date}] ${c.title}${snippet ? `（最近提到：${snippet}）` : ''}`
    })
    const insLines = insRecent.map((i) => {
      const date = new Date(i.startedAt).toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' })
      const status = i.status === 'running' ? '进行中' : i.status === 'completed' ? '已完成' : i.status === 'queued' ? '排队中' : '失败'
      return `- [${date}] ${i.agentName}：${i.task.slice(0, 50)}（${status}）`
    })
    return (
      `\n\n## 主人近期工作上下文\n` +
      `（你是主人的同事：参考以下背景接手/执行任务，避免重复劳动、保持口径一致；不要主动打扰主人）\n` +
      `近期对话：\n${lines.join('\n')}` +
      (insLines.length ? `\n近期后台任务：\n${insLines.join('\n')}` : '')
    )
  } catch {
    return ''
  }
}
