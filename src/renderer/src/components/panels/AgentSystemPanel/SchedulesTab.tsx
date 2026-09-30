import { useState } from 'react'
import { Clock, Plus, Trash2, Loader2, CalendarClock, CheckCircle2, XCircle, PauseCircle, PlayCircle, Webhook, Sunrise } from 'lucide-react'
import type { AgentSchedule, ScheduleDraft, ScheduleKind } from '@shared/agent-schedule'
import type { AgentDefinition } from '@shared/agent-definition'
import { describeSchedule } from '@shared/agent-schedule'

interface SchedulesTabProps {
  schedules: AgentSchedule[]
  definitions: AgentDefinition[]
  loading: boolean
  creating: boolean
  paused: boolean
  onTogglePause: () => void
  onCreate: (draft: ScheduleDraft) => void
  onDelete: (id: string) => void
  onToggle: (schedule: AgentSchedule) => void
}

const KIND_LABELS: Record<ScheduleKind, string> = {
  interval: '固定间隔',
  daily: '每天',
  weekly: '每周',
}

/** 定时任务 Tab — 到点自动派发给绑定的 Agent 定义执行 */
export function SchedulesTab({ schedules, definitions, loading, creating, paused, onTogglePause, onCreate, onDelete, onToggle }: SchedulesTabProps): React.ReactElement {
  const [showForm, setShowForm] = useState(false)
  const [name, setName] = useState('')
  const [prompt, setPrompt] = useState('')
  const [agentId, setAgentId] = useState('')
  const [kind, setKind] = useState<ScheduleKind>('daily')
  const [intervalMinutes, setIntervalMinutes] = useState('60')
  const [time, setTime] = useState('09:00')
  const [weekdays, setWeekdays] = useState<number[]>([1, 2, 3, 4, 5])
  const [catchUp, setCatchUp] = useState(false)

  const WEEK = ['日', '一', '二', '三', '四', '五', '六']
  const effectiveAgentId = agentId || definitions[0]?.id || ''
  const agentNameOf = (id: string): string => definitions.find((d) => d.id === id)?.name ?? '通用助手'

  const submit = (): void => {
    if (!effectiveAgentId) return
    onCreate({
      name, prompt, agentId: effectiveAgentId, kind, enabled: true, catchUp,
      intervalMinutes: kind === 'interval' ? Number(intervalMinutes) : undefined,
      time: kind === 'interval' ? undefined : time,
      weekdays: kind === 'weekly' ? weekdays : undefined,
    })
    setName(''); setPrompt(''); setShowForm(false)
  }

  /** 晨报模板 — 一键预填每日工作简报任务 */
  const prefillBriefing = (): void => {
    setName('每日晨报')
    setPrompt('基于主人近期工作上下文，生成今日晨报：① 昨日工作回顾 ② 今日待办与优先级建议 ③ 近期文件与后台任务动态。用简洁清单输出，控制在 300 字内。')
    setAgentId(definitions[0]?.id ?? '')
    setKind('daily')
    setTime('09:00')
    setCatchUp(true)
    setShowForm(true)
  }

  return (
    <div className="flex flex-col gap-2 p-3">
      <div className="flex items-center justify-between px-1">
        <p className="text-caption text-text-muted">
          应用运行期间到点自动执行 · 每次自动新建会话并派发给绑定的 Agent
        </p>
        <div className="flex items-center gap-1.5">
          <button
            onClick={onTogglePause}
            className={`flex items-center gap-1 rounded-control px-2 py-1 text-xs transition-colors ${
              paused ? 'bg-state-warning/15 text-state-warning hover:bg-state-warning/25' : 'bg-bg-hover text-text-muted hover:text-text-secondary'
            }`}
            title={paused ? '已全局暂停，点击恢复调度' : '点击暂停所有定时任务'}
          >
            {paused ? <PlayCircle size={11} /> : <PauseCircle size={11} />}
            {paused ? '已暂停' : '全局暂停'}
          </button>
          <button
            onClick={prefillBriefing}
            className="flex items-center gap-1 rounded-control bg-bg-hover px-2 py-1 text-xs text-text-secondary hover:text-text-primary"
            title="预填每日晨报定时任务"
          >
            <Sunrise size={11} />晨报模板
          </button>
          <button
            onClick={() => setShowForm((v) => !v)}
            className="flex items-center gap-1 rounded-control bg-accent/15 px-2 py-1 text-xs text-accent hover:bg-accent/25"
          >
            {showForm ? '收起' : <><Plus size={11} />新建</>}
          </button>
        </div>

        {paused && (
          <div className="rounded-card border border-state-warning/30 bg-state-warning/10 px-3 py-1.5 text-caption text-state-warning">
            定时任务已全局暂停 — 现有任务保留，恢复后按计划继续调度。
          </div>
        )}
      </div>

      {showForm && (
        <div className="flex flex-col gap-2 rounded-card border border-border-subtle bg-bg-elevated-soft p-3">
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="任务名称，如：每日晨报"
            className="rounded-control bg-bg-input border border-border-subtle px-2 py-1.5 text-xs text-text-primary outline-none placeholder:text-text-quaternary focus:border-accent/40"
          />
          <textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder="任务指令，如：整理昨日知识库新增内容，生成一份摘要"
            rows={2}
            className="resize-none rounded-control bg-bg-input border border-border-subtle px-2 py-1.5 text-xs text-text-primary outline-none placeholder:text-text-quaternary focus:border-accent/40"
          />

          <div className="flex items-center gap-1.5">
            <span className="text-caption text-text-muted shrink-0">执行者</span>
            <select
              value={effectiveAgentId}
              onChange={(e) => setAgentId(e.target.value)}
              className="min-w-0 flex-1 rounded-control bg-bg-input border border-border-subtle px-2 py-1.5 text-xs text-text-primary outline-none focus:border-accent/40"
            >
              {definitions.map((d) => (
                <option key={d.id} value={d.id}>{d.emoji} {d.name}</option>
              ))}
            </select>
          </div>

          <div className="flex items-center gap-1.5">
            {(Object.keys(KIND_LABELS) as ScheduleKind[]).map((k) => (
              <button
                key={k}
                onClick={() => setKind(k)}
                className={`rounded-control px-2 py-1 text-caption transition-colors ${
                  kind === k ? 'bg-accent/15 text-accent' : 'bg-bg-hover text-text-muted hover:text-text-secondary'
                }`}
              >
                {KIND_LABELS[k]}
              </button>
            ))}
          </div>

          {kind === 'interval' ? (
            <div className="flex items-center gap-1.5 text-xs text-text-secondary">
              每
              <input
                value={intervalMinutes}
                onChange={(e) => setIntervalMinutes(e.target.value.replace(/\D/g, ''))}
                className="w-16 rounded-control bg-bg-input border border-border-subtle px-2 py-1 text-center text-xs outline-none focus:border-accent/40"
              />
              分钟执行一次
            </div>
          ) : (
            <div className="flex flex-col gap-1.5">
              {kind === 'weekly' && (
                <div className="flex items-center gap-1">
                  {WEEK.map((d, i) => (
                    <button
                      key={i}
                      onClick={() => setWeekdays((prev) => prev.includes(i) ? prev.filter((x) => x !== i) : [...prev, i])}
                      className={`h-6 w-6 rounded-control text-caption transition-colors ${
                        weekdays.includes(i) ? 'bg-accent/15 text-accent' : 'bg-bg-hover text-text-muted'
                      }`}
                    >
                      {d}
                    </button>
                  ))}
                </div>
              )}
              <input
                type="time"
                value={time}
                onChange={(e) => setTime(e.target.value)}
                className="w-28 rounded-control bg-bg-input border border-border-subtle px-2 py-1 text-xs outline-none focus:border-accent/40"
              />
            </div>
          )}

          <label className="flex items-center gap-1.5 text-caption text-text-secondary">
            <input type="checkbox" checked={catchUp} onChange={(e) => setCatchUp(e.target.checked)} />
            错过补跑 — 应用未运行错过时刻后，启动时自动补执行一次
          </label>

          <button
            onClick={submit}
            disabled={creating || !name.trim() || !prompt.trim() || !effectiveAgentId}
            className="flex items-center justify-center gap-1.5 rounded-control bg-accent px-2 py-1.5 text-xs text-white transition-colors hover:bg-accent/85 disabled:opacity-40"
          >
            {creating ? <Loader2 size={11} className="animate-spin" /> : <CalendarClock size={11} />}
            创建定时任务
          </button>
        </div>
      )}

      {loading ? (
        <div className="flex items-center justify-center py-10 text-text-muted">
          <Loader2 size={18} className="animate-spin" />
        </div>
      ) : schedules.length === 0 ? (
        <p className="py-8 text-center text-caption text-text-muted">还没有定时任务 — 点上方「新建」创建一个</p>
      ) : (
        schedules.map((s) => (
          <div key={s.id} className="flex items-center gap-2 rounded-card border border-border-subtle bg-bg-elevated-soft px-3 py-2">
            <Clock size={13} className={`shrink-0 ${s.enabled ? 'text-accent' : 'text-text-quaternary'}`} />
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-1.5">
                <span className="truncate text-xs font-medium text-text-primary">{s.name}</span>
                <span className="shrink-0 text-caption text-accent">{agentNameOf(s.agentId)}</span>
              </div>
              <p className="truncate text-caption text-text-muted">
                {describeSchedule(s)}
                {s.lastRunAt && (
                  <> · 上次 {new Date(s.lastRunAt).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
                    {s.lastRunStatus === 'fired' && <CheckCircle2 size={9} className="ml-0.5 inline text-state-success" />}
                    {(s.lastRunStatus === 'error' || s.lastRunStatus === 'skipped') && <XCircle size={9} className="ml-0.5 inline text-state-error" />}
                  </>
                )}
                {s.lastRunMessage && ` · ${s.lastRunMessage}`}
              </p>
            </div>
            <button
              onClick={() => onToggle(s)}
              className={`relative h-4 w-8 shrink-0 rounded-full transition-colors ${s.enabled ? 'bg-accent' : 'bg-bg-hover'}`}
              title={s.enabled ? '点击停用' : '点击启用'}
            >
              <span className={`absolute top-0.5 h-3 w-3 rounded-full bg-white transition-all ${s.enabled ? 'left-4' : 'left-0.5'}`} />
            </button>
            <button
              onClick={() => onDelete(s.id)}
              className="icon-btn shrink-0 rounded-control p-1 text-text-muted hover:text-state-error"
              title="删除"
            >
              <Trash2 size={12} />
            </button>
          </div>
        ))
      )}

      <div className="mt-1 flex items-start gap-1.5 rounded-card bg-bg-hover-soft px-3 py-2 text-caption text-text-muted">
        <Webhook size={11} className="mt-0.5 shrink-0" />
        <span>
          Webhook 触发：向 <code className="text-text-secondary">http://127.0.0.1:17888/fire</code> 发 POST 请求
          （body: <code className="text-text-secondary">{'{"agentId":"...","task":"..."}'}</code>，agentId 缺省用通用助手），即可从外部脚本 / 手机快捷指令拉起任务。
        </span>
      </div>
    </div>
  )
}
