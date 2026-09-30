// ====== Agent 定时任务 — 主进程（调度/持久化）与渲染进程（面板）共用 ======

export type ScheduleKind = 'interval' | 'daily' | 'weekly'

export interface AgentSchedule {
  id: string
  name: string
  /** 到点后发给 Agent 的任务指令 */
  prompt: string
  /** 执行此任务的 Agent 定义 id */
  agentId: string
  kind: ScheduleKind
  /** interval：间隔分钟数（首次触发 = 创建时间 + 间隔） */
  intervalMinutes?: number
  /** daily/weekly：'HH:MM' */
  time?: string
  /** weekly：生效星期（0=周日），缺省视为每天 */
  weekdays?: number[]
  /** 错过补跑 — 应用未运行错过时刻后，启动时补执行一次 */
  catchUp?: boolean
  enabled: boolean
  createdAt: number
  lastRunAt?: number
  lastRunStatus?: 'fired' | 'skipped' | 'error'
  lastRunMessage?: string
}

/** 创建/编辑面板提交的任务草稿 */
export interface ScheduleDraft {
  name: string
  prompt: string
  /** 执行此任务的 Agent 定义 id（缺省用内置通用助手） */
  agentId?: string
  kind: ScheduleKind
  intervalMinutes?: number
  time?: string
  weekdays?: number[]
  /** 错过补跑 */
  catchUp?: boolean
  enabled: boolean
}

/** 把 ScheduleDraft 规范化为可存储的 AgentSchedule（校验失败返回 null） */
export function normalizeScheduleDraft(
  draft: ScheduleDraft,
  base?: Pick<AgentSchedule, 'id' | 'createdAt' | 'lastRunAt' | 'lastRunStatus' | 'lastRunMessage'>
): AgentSchedule | null {
  const name = draft.name.trim()
  const prompt = draft.prompt.trim()
  if (!name || !prompt) return null
  const agentId = draft.agentId?.trim() || 'agent_default_assistant'

  if (draft.kind === 'interval') {
    const minutes = Math.floor(Number(draft.intervalMinutes))
    if (!Number.isFinite(minutes) || minutes < 1) return null
    return {
      ...(base ?? { id: '', createdAt: Date.now() }),
      name, prompt, agentId,
      kind: 'interval',
      intervalMinutes: minutes,
      catchUp: !!draft.catchUp,
      enabled: !!draft.enabled,
    }
  }

  const time = draft.time ?? ''
  if (!/^\d{2}:\d{2}$/.test(time)) return null
  const [h, m] = time.split(':').map(Number)
  if (h > 23 || m > 59) return null

  if (draft.kind === 'weekly') {
    const weekdays = (draft.weekdays ?? []).filter((d) => Number.isInteger(d) && d >= 0 && d <= 6)
    if (weekdays.length === 0) return null
    return {
      ...(base ?? { id: '', createdAt: Date.now() }),
      name, prompt, agentId,
      kind: 'weekly',
      time,
      weekdays: [...weekdays].sort((a, b) => a - b),
      catchUp: !!draft.catchUp,
      enabled: !!draft.enabled,
    }
  }

  return {
    ...(base ?? { id: '', createdAt: Date.now() }),
    name, prompt, agentId,
    kind: 'daily',
    time,
    enabled: !!draft.enabled,
  }
}

/** 人类可读的调度描述（面板列表展示用） */
export function describeSchedule(s: Pick<AgentSchedule, 'kind' | 'intervalMinutes' | 'time' | 'weekdays'>): string {
  const WEEK = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']
  if (s.kind === 'interval') return `每 ${s.intervalMinutes} 分钟`
  if (s.kind === 'daily') return `每天 ${s.time}`
  const days = (s.weekdays ?? []).map((d) => WEEK[d]).join('、')
  return `${days} ${s.time}`
}
