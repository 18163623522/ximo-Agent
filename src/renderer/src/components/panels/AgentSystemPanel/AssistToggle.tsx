import { useEffect, useState } from 'react'
import { Eye, Loader2 } from 'lucide-react'

/**
 * AssistToggle — 工作分摊开关
 *
 * 开启后主进程定时感知用户电脑（窗口标题 + 前台文本大纲，不截图不落盘），
 * 发现可分担的工作先弹窗征求同意，用户接受才派后台 Agent 执行。
 */
export function AssistToggle(): React.ReactElement {
  const [enabled, setEnabled] = useState(false)
  const [busy, setBusy] = useState(false)
  const [lastCheckAt, setLastCheckAt] = useState(0)

  useEffect(() => {
    window.api.assist.get()
      .then((r) => { setEnabled(r.enabled); setLastCheckAt(r.lastCheckAt) })
      .catch(() => {})
  }, [])

  const toggle = async (): Promise<void> => {
    setBusy(true)
    try {
      const r = await window.api.assist.set(!enabled)
      setEnabled(r.enabled)
    } catch { /* 开关失败保持原状 */ }
    finally { setBusy(false) }
  }

  const lastCheck = lastCheckAt > 0
    ? new Date(lastCheckAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
    : null

  return (
    <button
      onClick={toggle}
      disabled={busy}
      className="mx-4 mt-3 flex w-[calc(100%-2rem)] items-center gap-3 rounded-card border border-border-subtle bg-bg-elevated px-3 py-2.5 text-left transition-colors hover:border-border-hover active:scale-[0.99] disabled:opacity-60"
    >
      <Eye size={15} className={`shrink-0 ${enabled ? 'text-accent' : 'text-text-quaternary'}`} />
      <div className="min-w-0 flex-1">
        <p className="text-xs font-medium text-text-primary">工作分摊</p>
        <p className="text-caption text-text-muted">
          {enabled
            ? `每 10 分钟感知一次我的电脑，可分担的工作会先弹窗征求同意${lastCheck ? ` · 上次检查 ${lastCheck}` : ''}`
            : '开启后定期感知我的电脑，发现可分担的工作先弹窗征求同意，再派后台 Agent 执行'}
        </p>
      </div>
      {busy ? (
        <Loader2 size={14} className="shrink-0 animate-spin text-text-muted" />
      ) : (
        <span className={`relative h-5 w-9 shrink-0 rounded-full transition-colors ${enabled ? 'bg-accent' : 'bg-border'}`}>
          <span className={`absolute left-0.5 top-0.5 h-4 w-4 rounded-full bg-white transition-transform ${enabled ? 'translate-x-4' : ''}`} />
        </span>
      )}
    </button>
  )
}
