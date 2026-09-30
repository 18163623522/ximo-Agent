import { useEffect, useState } from 'react'
import { Loader2, CheckCircle2, XCircle, Square, Plus, MessageSquare, RotateCw, Hourglass, Coins } from 'lucide-react'
import type { AgentDefinition, AgentInstance } from '@shared/agent-definition'

interface InstancesTabProps {
  instances: AgentInstance[]
  definitions: AgentDefinition[]
  /** 实时活动流 — instanceId → 当前动作 */
  activityMap: Record<string, string>
  starting: boolean
  onStart: (agentId: string, task: string) => void
  onStop: (id: string) => void
  /** 重试失败的实例 — 同 Agent 同任务再跑一次 */
  onRetry: (agentId: string, task: string) => void
  onOpenConversation: (conversationId: string) => void
}

const fmtTokens = (n: number): string => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n))

/** 实例管理 — 后台并行执行的 Agent 实例：排队/运行中/已完成/失败，点击直达会话 */
export function InstancesTab({ instances, definitions, activityMap, starting, onStart, onStop, onRetry, onOpenConversation }: InstancesTabProps): React.ReactElement {
  const [showForm, setShowForm] = useState(false)
  const [agentId, setAgentId] = useState('')
  const [task, setTask] = useState('')
  // 运行中实例的耗时实时刷新
  const [, setTick] = useState(0)

  useEffect(() => {
    if (!instances.some((i) => i.status === 'running')) return
    const timer = setInterval(() => setTick((t) => t + 1), 1000)
    return () => clearInterval(timer)
  }, [instances])

  const effectiveAgentId = agentId || definitions[0]?.id || ''
  const runningCount = instances.filter((i) => i.status === 'running').length
  const canStart = !starting && effectiveAgentId && task.trim().length > 0 && runningCount < 3

  // 今日用量 — 汇总今天完成的实例 token
  const today = new Date().toDateString()
  const todayTokens = instances
    .filter((i) => i.finishedAt && new Date(i.finishedAt).toDateString() === today)
    .reduce((sum, i) => sum + (i.tokens?.total ?? 0), 0)

  const submit = (): void => {
    if (!canStart) return
    onStart(effectiveAgentId, task.trim())
    setTask('')
    setShowForm(false)
  }

  const elapsed = (ins: AgentInstance): string => {
    const end = ins.finishedAt ?? Date.now()
    const sec = Math.max(0, Math.round((end - ins.startedAt) / 1000))
    return sec >= 60 ? `${Math.floor(sec / 60)} 分 ${sec % 60} 秒` : `${sec} 秒`
  }

  return (
    <div className="flex flex-col gap-2 p-3">
      <div className="flex items-center justify-between px-1">
        <p className="text-caption text-text-muted">
          后台并行执行（上限 3 个）· 结果写入各自会话，点击直达
          {todayTokens > 0 && (
            <span className="ml-2 inline-flex items-center gap-0.5 text-text-tertiary">
              <Coins size={10} />今日 {fmtTokens(todayTokens)} tokens
            </span>
          )}
        </p>
        <button
          onClick={() => setShowForm((v) => !v)}
          className="flex items-center gap-1 rounded-control bg-accent/15 px-2 py-1 text-xs text-accent hover:bg-accent/25"
        >
          {showForm ? '收起' : <><Plus size={11} />新建实例</>}
        </button>
      </div>

      {showForm && (
        <div className="flex flex-col gap-2 rounded-card border border-border-subtle bg-bg-elevated-soft p-3">
          <select
            value={effectiveAgentId}
            onChange={(e) => setAgentId(e.target.value)}
            className="rounded-control bg-bg-input border border-border-subtle px-2 py-1.5 text-xs text-text-primary outline-none focus:border-accent/40"
          >
            {definitions.map((d) => (
              <option key={d.id} value={d.id}>{d.emoji} {d.name}</option>
            ))}
          </select>
          <textarea
            value={task}
            onChange={(e) => setTask(e.target.value)}
            placeholder="任务指令，如：整理本周知识库新增内容并生成摘要"
            rows={2}
            className="resize-none rounded-control bg-bg-input border border-border-subtle px-2 py-1.5 text-xs text-text-primary outline-none placeholder:text-text-quaternary focus:border-accent/40"
          />
          <button
            onClick={submit}
            disabled={!canStart}
            className="rounded-control bg-accent px-2 py-1.5 text-xs text-white transition-colors hover:bg-accent/85 disabled:opacity-40"
          >
            {starting ? '启动中…' : canStart ? '启动实例' : '并行已满或信息不完整'}
          </button>
        </div>
      )}

      {instances.length === 0 ? (
        <p className="py-8 text-center text-caption text-text-muted">还没有实例记录 — 新建一个，或由定时任务自动触发</p>
      ) : (
        instances.map((ins) => {
          const def = definitions.find((d) => d.id === ins.agentId)
          const activity = activityMap[ins.id] ?? ins.activity
          return (
            <div key={ins.id} className="flex items-start gap-2 rounded-card border border-border-subtle bg-bg-elevated-soft px-3 py-2">
              {ins.status === 'running' ? (
                <Loader2 size={14} className="mt-0.5 shrink-0 animate-spin text-accent" />
              ) : ins.status === 'queued' ? (
                <Hourglass size={14} className="mt-0.5 shrink-0 text-state-warning" />
              ) : ins.status === 'completed' ? (
                <CheckCircle2 size={14} className="mt-0.5 shrink-0 text-state-success" />
              ) : (
                <XCircle size={14} className="mt-0.5 shrink-0 text-state-error" />
              )}
              <button
                onClick={() => ins.conversationId && onOpenConversation(ins.conversationId)}
                className="min-w-0 flex-1 text-left"
                title="打开对应会话"
              >
                <div className="flex items-center gap-1.5">
                  <span className="shrink-0">{def?.emoji ?? '🤖'}</span>
                  <span className="truncate text-xs font-medium text-text-primary">{ins.task}</span>
                </div>
                <p className="truncate text-caption text-text-muted">
                  {ins.agentName}
                  {ins.status === 'queued' && ' · ⏳ 排队中（桌面实例串行执行）'}
                  {ins.status === 'running' && ` · 运行中 ${elapsed(ins)}`}
                  {ins.status !== 'running' && ins.status !== 'queued' && ` · ${elapsed(ins)}`}
                  {ins.tokens && ` · ${fmtTokens(ins.tokens.total)} tokens`}
                  {ins.source && ` · 来自「${ins.source.scheduleName}」`}
                </p>
                {ins.status === 'running' && activity && (
                  <p className="truncate text-caption text-accent/80">{activity}</p>
                )}
                {ins.status === 'completed' && ins.resultPreview && (
                  <p className="truncate text-caption text-text-tertiary">{ins.resultPreview}</p>
                )}
                {ins.status === 'error' && ins.error && (
                  <p className="truncate text-caption text-state-error">{ins.error}</p>
                )}
              </button>
              {ins.status === 'running' && (
                <button
                  onClick={() => onStop(ins.id)}
                  className="icon-btn shrink-0 rounded-control p-1 text-text-muted hover:text-state-error"
                  title="中止"
                >
                  <Square size={11} />
                </button>
              )}
              {ins.status === 'queued' && (
                <button
                  onClick={() => onStop(ins.id)}
                  className="icon-btn shrink-0 rounded-control p-1 text-text-muted hover:text-state-error"
                  title="取消排队"
                >
                  <Square size={11} />
                </button>
              )}
              {ins.status === 'error' && (
                <button
                  onClick={() => onRetry(ins.agentId, ins.task)}
                  className="icon-btn shrink-0 rounded-control p-1 text-text-muted hover:text-accent"
                  title="重试"
                >
                  <RotateCw size={12} />
                </button>
              )}
              {ins.status !== 'running' && (
                <button
                  onClick={() => ins.conversationId && onOpenConversation(ins.conversationId)}
                  className="icon-btn shrink-0 rounded-control p-1 text-text-muted hover:text-accent"
                  title="打开对应会话"
                >
                  <MessageSquare size={12} />
                </button>
              )}
            </div>
          )
        })
      )}
    </div>
  )
}
