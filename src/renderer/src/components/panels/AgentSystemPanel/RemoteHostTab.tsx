import { useEffect, useState } from 'react'
import {
  Loader2, CheckCircle2, XCircle, Square, Radio, PlugZap, Plug,
  Send, ChevronRight, Server, ShieldAlert, Wallet,
} from 'lucide-react'
import type { HostTaskRecord, HostStatusInfo, HostMsg } from '@shared/types'
import { useStore } from '@renderer/store/useStore'

/** 审批待办 — 主机侧 ask 类操作征求同意（fail-closed：超时=拒绝） */
interface PendingApproval {
  reqId: string
  id: string
  tool: string
  summary: string
}

const STATUS_META: Record<HostTaskRecord['status'], { icon: typeof CheckCircle2; cls: string; label: string }> = {
  queued: { icon: Radio, cls: 'text-state-warning', label: '排队中' },
  running: { icon: Loader2, cls: 'text-accent', label: '运行中' },
  awaiting_approval: { icon: ShieldAlert, cls: 'text-state-warning', label: '等待审批' },
  completed: { icon: CheckCircle2, cls: 'text-state-success', label: '已完成' },
  failed: { icon: XCircle, cls: 'text-state-error', label: '失败' },
  cancelled: { icon: Square, cls: 'text-text-muted', label: '已取消' },
}

const CONN_META: Record<HostStatusInfo['status'], { dot: string; label: string }> = {
  connected: { dot: 'bg-state-success', label: '已连接' },
  connecting: { dot: 'bg-state-warning animate-pulse', label: '连接中…' },
  disconnected: { dot: 'bg-text-muted', label: '未连接' },
  error: { dot: 'bg-state-error', label: '连接异常' },
}

/**
 * 远程主机 Tab — ximo-OS 主机（agent-hostd）驾驶舱
 *
 * 数据源：主进程 HostClient 经 host:* 通道推送的连接状态 / 任务表 / 原始事件。
 * 派发的任务在主机侧独立执行，本面板只做控制面与转录展示，不进入本地会话。
 */
export function RemoteHostTab(): React.ReactElement {
  const settings = useStore((s) => s.settings)
  const updateSettings = useStore((s) => s.updateSettings)

  const [url, setUrl] = useState(settings?.hostUrl ?? '')
  const [token, setToken] = useState(settings?.hostToken ?? '')
  const [status, setStatus] = useState<HostStatusInfo>({ status: 'disconnected', url: '' })
  const [tasks, setTasks] = useState<HostTaskRecord[]>([])
  const [taskText, setTaskText] = useState('')
  const [mode, setMode] = useState('coding')
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const [approval, setApproval] = useState<PendingApproval | null>(null)
  const [dispatching, setDispatching] = useState(false)

  useEffect(() => {
    void window.api.host.status().then(setStatus)
    void window.api.host.listTasks().then(setTasks)
    const offStatus = window.api.host.onStatus(setStatus)
    const offTasks = window.api.host.onTasks(setTasks)
    const offEvent = window.api.host.onEvent((m: HostMsg) => {
      if (m.t === 'approval.request') {
        setApproval({ reqId: m.reqId, id: m.id, tool: m.tool, summary: m.summary })
      }
      if (m.t === 'task.done' && m.status === 'completed') {
        setNotice({ ok: true, text: `任务 ${m.id} 已完成` })
      }
    })
    return () => { offStatus(); offTasks(); offEvent() }
  }, [])

  const persistHostConfig = async (): Promise<void> => {
    await updateSettings({ hostUrl: url.trim(), hostToken: token.trim() })
  }

  const handleConnect = async (): Promise<void> => {
    if (!url.trim() || !token.trim()) {
      setNotice({ ok: false, text: '请填写主机地址与令牌' })
      return
    }
    setBusy(true)
    setNotice(null)
    try {
      await persistHostConfig()
      await window.api.host.connect(url.trim(), token.trim())
    } finally {
      setBusy(false)
    }
  }

  const handleDisconnect = async (): Promise<void> => {
    await window.api.host.disconnect()
    setNotice(null)
  }

  const handleTest = async (): Promise<void> => {
    setBusy(true)
    setNotice(null)
    try {
      const res = await window.api.host.health(url.trim(), token.trim())
      setNotice(res.ok
        ? { ok: true, text: `连接正常 — ${res.name ?? 'ximo-host'} v${res.version ?? '?'}（模式 ${res.mode ?? '-'}）` }
        : { ok: false, text: res.error ?? '连接失败' })
    } finally {
      setBusy(false)
    }
  }

  const handleDispatch = async (): Promise<void> => {
    const task = taskText.trim()
    if (!task) return
    setDispatching(true)
    setNotice(null)
    try {
      const res = await window.api.host.dispatch(task, mode)
      if (res.ok) {
        setTaskText('')
        setNotice({ ok: true, text: `任务已派发：${res.id}` })
        setSelected(res.id ?? null)
        setTasks(await window.api.host.listTasks())
      } else {
        setNotice({ ok: false, text: res.error ?? '派发失败' })
      }
    } finally {
      setDispatching(false)
    }
  }

  const handleApproval = async (allow: boolean): Promise<void> => {
    if (!approval) return
    await window.api.host.approvalRespond(approval.reqId, allow)
    setApproval(null)
  }

  const conn = CONN_META[status.status]
  const selectedTask = tasks.find((t) => t.id === selected) ?? null
  const runningCount = tasks.filter((t) => t.status === 'running' || t.status === 'queued').length

  return (
    <div className="flex flex-col gap-3 p-3">
      {/* 连接配置 */}
      <div className="rounded-card border border-border-subtle bg-bg-elevated-soft p-3">
        <div className="mb-2 flex items-center justify-between">
          <div className="flex items-center gap-1.5">
            <Server size={13} className="text-accent" />
            <span className="text-xs font-medium text-text-primary">ximo-OS 主机</span>
            <span className="flex items-center gap-1 text-caption text-text-muted">
              <span className={`h-1.5 w-1.5 rounded-full ${conn.dot}`} />
              {conn.label}
            </span>
          </div>
          {status.status === 'connected' ? (
            <button
              onClick={() => void handleDisconnect()}
              className="flex items-center gap-1 rounded-control px-2 py-1 text-xs text-text-muted hover:text-state-error"
            >
              <Plug size={11} />断开
            </button>
          ) : (
            <button
              onClick={() => void handleConnect()}
              disabled={busy}
              className="flex items-center gap-1 rounded-control bg-accent/15 px-2 py-1 text-xs text-accent hover:bg-accent/25 disabled:opacity-40"
            >
              <PlugZap size={11} />连接
            </button>
          )}
        </div>

        <div className="flex flex-col gap-2">
          <input
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="http://127.0.0.1:17890（WSL1 本机主机）"
            className="rounded-control border border-border-subtle bg-bg-input px-2 py-1.5 text-xs text-text-primary outline-none placeholder:text-text-quaternary focus:border-accent/40"
          />
          <input
            type="password"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            placeholder="访问令牌（主机首启生成，/opt/ximo-host/config/token）"
            className="rounded-control border border-border-subtle bg-bg-input px-2 py-1.5 text-xs text-text-primary outline-none placeholder:text-text-quaternary focus:border-accent/40"
          />
          <div className="flex items-center gap-2">
            <button
              onClick={() => void handleTest()}
              disabled={busy || !url.trim() || !token.trim()}
              className="rounded-control border border-border-subtle px-2 py-1 text-xs text-text-secondary hover:border-accent/40 hover:text-accent disabled:opacity-40"
            >
              测试连接
            </button>
            <span className="truncate text-caption text-text-muted">
              {status.error ?? '主机在同一台机器时用 WSL1 部署：wsl -d Debian -- /root/ximo-host/ximo-host run'}
            </span>
          </div>
          {status.error && <p className="text-caption text-state-error">{status.error}</p>}
        </div>
      </div>

      {notice && (
        <div className={`flex items-center gap-2 rounded-card px-3 py-2 text-caption ${
          notice.ok ? 'bg-state-success/10 text-state-success' : 'bg-state-error/10 text-state-error'
        }`}>
          {notice.ok ? <CheckCircle2 size={12} /> : <XCircle size={12} />}
          <span className="flex-1">{notice.text}</span>
        </div>
      )}

      {/* 审批待办 — 主机侧 ask 类操作（fail-closed：不响应超时即拒绝） */}
      {approval && (
        <div className="flex items-center gap-2 rounded-card border border-state-warning/40 bg-state-warning/10 px-3 py-2">
          <ShieldAlert size={14} className="shrink-0 text-state-warning" />
          <div className="min-w-0 flex-1">
            <p className="text-xs font-medium text-text-primary">主机请求审批：{approval.tool}</p>
            <p className="truncate text-caption text-text-muted">{approval.summary}</p>
          </div>
          <button
            onClick={() => void handleApproval(false)}
            className="rounded-control px-2 py-1 text-xs text-text-muted hover:text-state-error"
          >
            拒绝
          </button>
          <button
            onClick={() => void handleApproval(true)}
            className="rounded-control bg-accent px-2 py-1 text-xs text-white hover:bg-accent/85"
          >
            允许
          </button>
        </div>
      )}

      {/* 派任务 */}
      <div className="flex flex-col gap-2 rounded-card border border-border-subtle bg-bg-elevated-soft p-3">
        <textarea
          value={taskText}
          onChange={(e) => setTaskText(e.target.value)}
          placeholder="给主机派任务，例如：在工作区创建 hello.txt 并写入当前时间"
          rows={2}
          className="resize-none rounded-control border border-border-subtle bg-bg-input px-2 py-1.5 text-xs text-text-primary outline-none placeholder:text-text-quaternary focus:border-accent/40"
        />
        <div className="flex items-center gap-2">
          <select
            value={mode}
            onChange={(e) => setMode(e.target.value)}
            className="rounded-control border border-border-subtle bg-bg-input px-2 py-1 text-xs text-text-primary outline-none focus:border-accent/40"
          >
            <option value="coding">编程模式</option>
            <option value="office">办公模式</option>
          </select>
          <button
            onClick={() => void handleDispatch()}
            disabled={dispatching || !taskText.trim() || status.status !== 'connected'}
            className="flex items-center gap-1 rounded-control bg-accent px-3 py-1 text-xs text-white hover:bg-accent/85 disabled:opacity-40"
          >
            {dispatching ? <Loader2 size={11} className="animate-spin" /> : <Send size={11} />}
            派发
          </button>
          <span className="text-caption text-text-muted">
            {status.status !== 'connected' ? '未连接主机' : runningCount > 0 ? `${runningCount} 个任务进行中` : '任务串行执行'}
          </span>
        </div>
      </div>

      {/* 任务列表 */}
      {tasks.length === 0 ? (
        <p className="py-8 text-center text-caption text-text-muted">还没有任务 — 连接主机后派发一个试试</p>
      ) : (
        tasks.map((t) => {
          const meta = STATUS_META[t.status]
          const Icon = meta.icon
          const isOpen = selected === t.id
          return (
            <div key={t.id} className="overflow-hidden rounded-card border border-border-subtle bg-bg-elevated-soft">
              <button
                onClick={() => setSelected(isOpen ? null : t.id)}
                className="flex w-full items-start gap-2 px-3 py-2 text-left"
              >
                <Icon size={13} className={`mt-0.5 shrink-0 ${meta.cls} ${t.status === 'running' ? 'animate-spin' : ''}`} />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-xs font-medium text-text-primary">{t.task || t.id}</p>
                  <p className={`truncate text-caption ${t.status === 'awaiting_approval' ? 'text-state-warning' : 'text-text-muted'}`}>
                    {meta.label}
                    {t.result && ` · ${t.result.slice(0, 80)}`}
                    {t.error && ` · ${t.error}`}
                  </p>
                </div>
                <ChevronRight size={12} className={`mt-0.5 shrink-0 text-text-muted transition-transform ${isOpen ? 'rotate-90' : ''}`} />
                {(t.status === 'running' || t.status === 'queued') && (
                  <span
                    role="button"
                    tabIndex={0}
                    onClick={(e) => { e.stopPropagation(); void window.api.host.cancel(t.id) }}
                    onKeyDown={(e) => { if (e.key === 'Enter') { e.stopPropagation(); void window.api.host.cancel(t.id) } }}
                    className="shrink-0 rounded-control p-1 text-text-muted hover:text-state-error"
                    title="中止任务"
                  >
                    <Square size={11} />
                  </span>
                )}
              </button>

              {/* 转录 — 主机侧工具调用与文本增量 */}
              {isOpen && (
                <div className="max-h-64 overflow-y-auto border-t border-border-subtle bg-bg-base px-3 py-2">
                  {t.chunks.length === 0 ? (
                    <p className="text-caption text-text-muted">等待主机输出…</p>
                  ) : (
                    <div className="flex flex-col gap-1">
                      {t.chunks.map((c, i) => (
                        <p key={i} className="whitespace-pre-wrap break-words text-caption text-text-secondary">
                          {c.type === 'text' && c.text}
                          {c.type === 'tool' && <span className="text-accent">▶ {c.name} {c.argsSummary}</span>}
                          {c.type === 'tool_result' && (
                            <span className={c.success ? 'text-text-muted' : 'text-state-error'}>
                              {c.success ? '✓' : '✗'} {c.name} — {c.content.slice(0, 200)}
                            </span>
                          )}
                        </p>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          )
        })
      )}

      <p className="flex items-center gap-1 px-1 text-caption text-text-tertiary">
        <Wallet size={10} />
        任务在主机侧独立执行，不占用本地会话；审批超时 120s 自动拒绝（fail-closed）
      </p>
    </div>
  )
}
