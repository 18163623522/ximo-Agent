import { useState, useEffect, useCallback } from 'react'
import { X, Monitor, CalendarClock, Bot, AlertCircle, CheckCircle2, Server } from 'lucide-react'
import { useStore } from '@renderer/store/useStore'
import type { AgentDefinition, AgentInstance, } from '@shared/agent-definition'
import type { AgentSchedule, ScheduleDraft } from '@shared/agent-schedule'
import { InstancesTab } from './AgentSystemPanel/InstancesTab'
import { SchedulesTab } from './AgentSystemPanel/SchedulesTab'
import { DefinitionsTab } from './AgentSystemPanel/DefinitionsTab'
import { AssistToggle } from './AgentSystemPanel/AssistToggle'
import { RemoteHostTab } from './AgentSystemPanel/RemoteHostTab'

type TabId = 'instances' | 'schedules' | 'definitions' | 'host'

const LAST_SEEN_KEY = 'ximo-agent-system-last-seen'

/**
 * AgentSystemPanel — Agent 系统面板（多 Agent 并行控制中心）
 *
 * 左侧栏「能力」组入口，与专家库 / MCP / 技能同形态。
 * - 实例：后台并行执行的 Agent 实例，结果写回各自会话
 * - 定时任务：到点自动派发给绑定的 Agent 定义（支持全局暂停 / 错过补跑）
 * - Agent 定义：可复用的执行角色（职责/桌面/审批策略）
 */
export function AgentSystemPanel(): React.ReactElement | null {
  const show = useStore((s) => s.showAgentSystemPanel)
  const setShow = useStore((s) => s.setShowAgentSystemPanel)
  const selectConversation = useStore((s) => s.selectConversation)

  const [activeTab, setActiveTab] = useState<TabId>('instances')
  const [instances, setInstances] = useState<AgentInstance[]>([])
  const [definitions, setDefinitions] = useState<AgentDefinition[]>([])
  const [schedulesLocal, setSchedulesLocal] = useState<AgentSchedule[]>([])
  const [paused, setPaused] = useState(false)
  const [activityMap, setActivityMap] = useState<Record<string, string>>({})
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [starting, setStarting] = useState(false)
  const [creating, setCreating] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  const loadInstances = useCallback(async (): Promise<void> => {
    try {
      const res = await window.api.agentSystem.listInstances()
      if (res.success) setInstances(res.instances)
    } catch (e) {
      setError((e as Error).message)
    }
  }, [])

  const loadDefinitions = useCallback(async (): Promise<void> => {
    try {
      const res = await window.api.agentSystem.listDefinitions()
      if (res.success) setDefinitions(res.definitions)
    } catch (e) {
      setError((e as Error).message)
    }
  }, [])

  const loadSchedules = useCallback(async (): Promise<void> => {
    try {
      const res = await window.api.schedules.list()
      if (res.success) setSchedulesLocal(res.schedules)
      const p = await window.api.schedules.getPaused()
      setPaused(p.paused)
    } catch (e) {
      setError((e as Error).message)
    }
  }, [])

  useEffect(() => {
    if (!show) return
    setLoading(true)
    void Promise.all([loadInstances(), loadDefinitions(), loadSchedules()]).finally(() => setLoading(false))
    // 实例状态推送 — 实时刷新列表
    return window.api.agentSystem.onInstancesUpdated(() => { void loadInstances() })
  }, [show, loadInstances, loadDefinitions, loadSchedules])

  // 实时活动流 — 更新实例行的当前动作
  useEffect(() => {
    return window.api.agentSystem.onInstanceActivity((data) => {
      setActivityMap((prev) => ({ ...prev, [data.instanceId]: data.activity }))
    })
  }, [])

  // 打开面板即清除未读（Sidebar 徽标按此时间戳计算）
  useEffect(() => {
    if (show) localStorage.setItem(LAST_SEEN_KEY, String(Date.now()))
  }, [show])

  const handleStart = useCallback(async (agentId: string, task: string): Promise<void> => {
    setStarting(true)
    setError(null)
    setNotice(null)
    try {
      const res = await window.api.agentSystem.startInstance({ agentId, task })
      if (res.success) {
        setNotice('实例已启动，结果将写入新会话')
        await loadInstances()
      } else {
        setError(res.message ?? '启动失败')
      }
    } catch (e) {
      setError((e as Error).message)
    }
    setStarting(false)
  }, [loadInstances])

  const handleStop = useCallback(async (id: string): Promise<void> => {
    try {
      await window.api.agentSystem.stopInstance(id)
      await loadInstances()
    } catch (e) {
      setError((e as Error).message)
    }
  }, [loadInstances])

  const handleOpenConversation = useCallback((conversationId: string): void => {
    selectConversation(conversationId)
    setShow(false)
  }, [selectConversation, setShow])

  const handleCreateDefinition = useCallback(async (draft: Omit<AgentDefinition, 'id'>): Promise<void> => {
    setSaving(true)
    setError(null)
    try {
      const res = await window.api.agentSystem.createDefinition(draft)
      if (res.success) setNotice(`Agent「${draft.name}」已创建`)
      else setError(res.message ?? '创建失败')
      await loadDefinitions()
    } catch (e) {
      setError((e as Error).message)
    }
    setSaving(false)
  }, [loadDefinitions])

  const handleUpdateDefinition = useCallback(async (id: string, patch: Omit<AgentDefinition, 'id'>): Promise<void> => {
    setSaving(true)
    setError(null)
    try {
      const res = await window.api.agentSystem.updateDefinition(id, patch)
      if (res.success) setNotice(`Agent「${patch.name}」已更新`)
      else setError(res.message ?? '更新失败')
      await loadDefinitions()
    } catch (e) {
      setError((e as Error).message)
    }
    setSaving(false)
  }, [loadDefinitions])

  const handleDeleteDefinition = useCallback(async (id: string): Promise<void> => {
    try {
      await window.api.agentSystem.deleteDefinition(id)
      await loadDefinitions()
    } catch (e) {
      setError((e as Error).message)
    }
  }, [loadDefinitions])

  const handleCreateSchedule = useCallback(async (draft: ScheduleDraft): Promise<void> => {
    setCreating(true)
    setError(null)
    setNotice(null)
    try {
      const res = await window.api.schedules.create(draft)
      if (res.success) {
        setNotice(`定时任务「${draft.name}」已创建`)
        await loadSchedules()
      } else {
        setError(res.message ?? '创建失败')
      }
    } catch (e) {
      setError((e as Error).message)
    }
    setCreating(false)
  }, [loadSchedules])

  const handleToggleSchedule = useCallback(async (schedule: AgentSchedule): Promise<void> => {
    setSchedulesLocal((prev) => prev.map((s) => (s.id === schedule.id ? { ...s, enabled: !s.enabled } : s)))
    try {
      const { enabled, ...rest } = schedule
      await window.api.schedules.update(schedule.id, { ...rest, enabled: !enabled })
    } catch (e) {
      setError((e as Error).message)
      await loadSchedules()
    }
  }, [loadSchedules])

  const handleDeleteSchedule = useCallback(async (id: string): Promise<void> => {
    setSchedulesLocal((prev) => prev.filter((s) => s.id !== id))
    try {
      await window.api.schedules.delete(id)
    } catch (e) {
      setError((e as Error).message)
      await loadSchedules()
    }
  }, [loadSchedules])

  const handleTogglePause = useCallback(async (): Promise<void> => {
    try {
      const res = await window.api.schedules.setPaused(!paused)
      setPaused(res.paused)
    } catch (e) {
      setError((e as Error).message)
    }
  }, [paused])

  if (!show) return null

  const tabs: { id: TabId; label: string; icon: typeof Bot }[] = [
    { id: 'instances', label: '实例', icon: Bot },
    { id: 'schedules', label: '定时任务', icon: CalendarClock },
    { id: 'definitions', label: 'Agent 定义', icon: Monitor },
    { id: 'host', label: '远程主机', icon: Server },
  ]

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm animate-fade-in"
      onClick={() => setShow(false)}
    >
      <div
        className="glass-panel flex h-[76vh] w-[760px] max-w-[95vw] flex-col overflow-hidden animate-fade-scale"
        onClick={(e) => e.stopPropagation()}
      >
        {/* 标题栏 */}
        <div className="flex items-center justify-between border-b border-border-subtle px-5 py-3.5">
          <div className="flex items-center gap-3">
            <div className="accent-tile flex h-9 w-9 items-center justify-center rounded-panel shadow-lg shadow-accent/20">
              <Monitor size={16} className="text-white" />
            </div>
            <div>
              <h2 className="text-base font-semibold text-text-primary">Agent 系统</h2>
              <p className="text-xs text-text-muted">
                多 Agent 并行执行 · 后台实例结果写入各自会话
              </p>
            </div>
          </div>
          <button onClick={() => setShow(false)} className="icon-btn rounded-card p-1.5">
            <X size={16} />
          </button>
        </div>

        {/* 工作分摊开关 — 感知用户电脑 → 弹窗征求 → 后台分摊 */}
        <AssistToggle />

        {/* Tab 导航 */}
        <div className="flex gap-1 border-b border-border-subtle px-4 pt-2.5">
          {tabs.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              onClick={() => setActiveTab(id)}
              className={`flex items-center gap-1.5 rounded-t-control border-b-2 px-3 py-2 text-xs transition-colors ${
                activeTab === id
                  ? 'border-accent text-accent'
                  : 'border-transparent text-text-muted hover:text-text-secondary'
              }`}
            >
              <Icon size={13} />
              {label}
            </button>
          ))}
        </div>

        {/* 状态条 */}
        {(error || notice) && (
          <div className={`flex items-center gap-2 px-4 py-2 text-caption ${
            error ? 'bg-state-error/10 text-state-error' : 'bg-state-success/10 text-state-success'
          }`}>
            {error ? <AlertCircle size={12} /> : <CheckCircle2 size={12} />}
            <span className="flex-1">{error ?? notice}</span>
          </div>
        )}

        {/* 内容区 */}
        <div className="min-h-0 flex-1 overflow-y-auto">
          {activeTab === 'instances' && (
            <InstancesTab
              instances={instances}
              definitions={definitions}
              activityMap={activityMap}
              starting={starting}
              onStart={(agentId, task) => void handleStart(agentId, task)}
              onStop={(id) => void handleStop(id)}
              onRetry={(agentId, task) => void handleStart(agentId, task)}
              onOpenConversation={handleOpenConversation}
            />
          )}
          {activeTab === 'schedules' && (
            <SchedulesTab
              schedules={schedulesLocal}
              definitions={definitions}
              loading={loading}
              creating={creating}
              paused={paused}
              onTogglePause={() => void handleTogglePause()}
              onCreate={(draft) => void handleCreateSchedule(draft)}
              onDelete={(id) => void handleDeleteSchedule(id)}
              onToggle={(s) => void handleToggleSchedule(s)}
            />
          )}
          {activeTab === 'definitions' && (
            <DefinitionsTab
              definitions={definitions}
              saving={saving}
              onCreate={(draft) => void handleCreateDefinition(draft)}
              onUpdate={(id, patch) => void handleUpdateDefinition(id, patch)}
              onDelete={(id) => void handleDeleteDefinition(id)}
            />
          )}
          {activeTab === 'host' && <RemoteHostTab />}
        </div>
      </div>
    </div>
  )
}
