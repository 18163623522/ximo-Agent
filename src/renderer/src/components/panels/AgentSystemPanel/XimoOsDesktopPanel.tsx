import { useCallback, useEffect, useRef, useState } from 'react'
import {
  X, Server, MousePointerClick, RefreshCw, Send, Loader2, Radio,
  AppWindow, Keyboard, ChevronRight,
} from 'lucide-react'
import type { DesktopWindow, DesktopScreenSize, HostStatusInfo, HostMsg, HostScreenSnapshot } from '@shared/types'

/** 主机画面流 — 主进程 ximo-host-cam:// 协议代理（Bearer 鉴权在主进程内完成） */
const STREAM_URL = 'ximo-host-cam://stream'

const CONN_META: Record<HostStatusInfo['status'], { dot: string; label: string }> = {
  connected: { dot: 'bg-state-success', label: '已连接' },
  connecting: { dot: 'bg-state-warning animate-pulse', label: '连接中…' },
  disconnected: { dot: 'bg-text-muted', label: '未连接' },
  error: { dot: 'bg-state-error', label: '连接异常' },
}

/**
 * XimoOsDesktopPanel — ximo-OS 桌面渲染端（阶段 2）
 *
 * headless-first 的 GUI 收口：画面由主机 ffmpeg 采集（经 ximo-host-cam:// 代理），
 * 窗口/应用/键鼠全部走 desktop-bus 纯 API —— 面板只是总线的又一个客户端。
 */
export function XimoOsDesktopPanel({ onClose }: { onClose: () => void }): React.ReactElement {
  const [status, setStatus] = useState<HostStatusInfo | null>(null)
  const [streamFailed, setStreamFailed] = useState(false)
  const [snapshot, setSnapshot] = useState<string | null>(null)
  const [screenSize, setScreenSize] = useState<DesktopScreenSize | null>(null)
  const [windows, setWindows] = useState<DesktopWindow[]>([])
  const [interact, setInteract] = useState(true)
  const [keys, setKeys] = useState('')
  const [typeText, setTypeText] = useState('')
  const [app, setApp] = useState('')
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const imgRef = useRef<HTMLImageElement>(null)

  const refreshWindows = useCallback(async (): Promise<void> => {
    const res = await window.api.host.desktop('window.list')
    if (res.ok) setWindows((res.data as DesktopWindow[]) ?? [])
  }, [])

  useEffect(() => {
    void window.api.host.status().then(setStatus)
    void window.api.host.desktop('screen.size').then((r) => {
      if (r.ok) setScreenSize(r.data as DesktopScreenSize)
    })
    void refreshWindows()
    const offStatus = window.api.host.onStatus(setStatus)
    const offEvent = window.api.host.onEvent((m: HostMsg) => {
      if (m.t === 'desktop.event' && m.kind === 'window') void refreshWindows()
    })
    return () => { offStatus(); offEvent() }
  }, [refreshWindows])

  // 画面流不可用 → 快照轮询兜底（2s）
  useEffect(() => {
    if (!streamFailed || status?.status !== 'connected') return
    let stopped = false
    const poll = async (): Promise<void> => {
      while (!stopped) {
        const snap: HostScreenSnapshot = await window.api.host.screenSnapshot()
        if (snap.ok && snap.screenshot) setSnapshot(snap.screenshot)
        await new Promise((r) => setTimeout(r, 2000))
      }
    }
    void poll()
    return () => { stopped = true }
  }, [streamFailed, status?.status])

  const desktop = useCallback(async (action: Parameters<typeof window.api.host.desktop>[0], params?: Record<string, unknown>): Promise<void> => {
    setBusy(true)
    try {
      const res = await window.api.host.desktop(action, params)
      if (!res.ok) setNotice(res.error ?? '操作失败')
      else setNotice(null)
    } finally {
      setBusy(false)
    }
  }, [])

  /** 画布坐标 → 屏幕真实坐标（按渲染尺寸等比映射） */
  const mapPoint = (e: React.MouseEvent): { x: number; y: number } | null => {
    const img = imgRef.current
    if (!img || !screenSize) return null
    const rect = img.getBoundingClientRect()
    if (!rect.width || !rect.height) return null
    return {
      x: Math.round(((e.clientX - rect.left) / rect.width) * screenSize.width),
      y: Math.round(((e.clientY - rect.top) / rect.height) * screenSize.height),
    }
  }

  const handleStageClick = (e: React.MouseEvent): void => {
    if (!interact) return
    const p = mapPoint(e)
    if (p) void desktop('mouse.click', { ...p, button: 'left' })
  }

  const handleStageWheel = (e: React.WheelEvent): void => {
    if (!interact) return
    const p = mapPoint(e as unknown as React.MouseEvent)
    void desktop('mouse.scroll', { ...(p ?? {}), direction: e.deltaY < 0 ? 'up' : 'down', amount: 3 })
  }

  const connected = status?.status === 'connected'
  const conn = CONN_META[status?.status ?? 'disconnected']

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm animate-fade-in" onClick={onClose}>
      <div
        className="glass-panel flex h-[86vh] w-[1100px] max-w-[96vw] flex-col overflow-hidden animate-fade-scale"
        onClick={(e) => e.stopPropagation()}
      >
        {/* 标题栏 */}
        <div className="flex items-center justify-between border-b border-border-subtle px-5 py-3">
          <div className="flex items-center gap-2.5">
            <div className="accent-tile flex h-8 w-8 items-center justify-center rounded-panel">
              <Server size={15} className="text-white" />
            </div>
            <div>
              <h2 className="text-sm font-semibold text-text-primary">ximo-OS 桌面</h2>
              <p className="flex items-center gap-1 text-caption text-text-muted">
                <span className={`h-1.5 w-1.5 rounded-full ${conn.dot}`} />
                {conn.label}
                {screenSize ? ` · ${screenSize.width}x${screenSize.height}` : ''}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => setInteract((v) => !v)}
              className={`flex items-center gap-1 rounded-control px-2 py-1 text-xs transition-colors ${
                interact ? 'bg-accent/15 text-accent' : 'text-text-muted hover:text-text-secondary'
              }`}
              title="开启后：点击画面 = 在主机桌面点击"
            >
              <MousePointerClick size={12} />
              {interact ? '交互中' : '仅观看'}
            </button>
            <button onClick={() => { setStreamFailed(false); void refreshWindows() }} className="icon-btn rounded-control p-1.5" title="重连画面流">
              <RefreshCw size={14} />
            </button>
            <button onClick={onClose} className="icon-btn rounded-card p-1.5"><X size={15} /></button>
          </div>
        </div>

        {notice && <p className="bg-state-error/10 px-5 py-1.5 text-caption text-state-error">{notice}</p>}

        <div className="flex min-h-0 flex-1">
          {/* 画面舞台 */}
          <div className="flex min-w-0 flex-1 items-center justify-center bg-black/40 p-3">
            {!connected ? (
              <p className="text-caption text-text-muted">未连接主机 — 在「远程主机」标签页连接后再打开桌面</p>
            ) : streamFailed ? (
              snapshot ? (
                <img ref={imgRef} src={snapshot} alt="ximo-OS 桌面快照" className="max-h-full max-w-full rounded-card object-contain"
                  onClick={handleStageClick} onWheel={handleStageWheel}
                  style={{ cursor: interact ? 'crosshair' : 'default' }} />
              ) : (
                <div className="flex flex-col items-center gap-2 text-text-muted">
                  <Loader2 size={18} className="animate-spin" />
                  <p className="text-caption">画面流未就绪，快照获取中…</p>
                </div>
              )
            ) : (
              <img
                ref={imgRef}
                src={STREAM_URL}
                alt="ximo-OS 桌面实时画面"
                className="max-h-full max-w-full rounded-card object-contain"
                onError={() => setStreamFailed(true)}
                onClick={handleStageClick}
                onWheel={handleStageWheel}
                style={{ cursor: interact ? 'crosshair' : 'default' }}
              />
            )}
          </div>

          {/* 右侧操作栏 */}
          <div className="flex w-60 shrink-0 flex-col gap-3 overflow-y-auto border-l border-border-subtle p-3">
            {/* 应用启动 */}
            <div>
              <p className="mb-1.5 flex items-center gap-1 text-xs font-medium text-text-primary"><AppWindow size={12} className="text-accent" />启动应用</p>
              <div className="flex gap-1">
                <input
                  value={app}
                  onChange={(e) => setApp(e.target.value)}
                  placeholder="如 xfce4-terminal"
                  className="min-w-0 flex-1 rounded-control border border-border-subtle bg-bg-input px-2 py-1 text-xs text-text-primary outline-none placeholder:text-text-quaternary focus:border-accent/40"
                />
                <button
                  onClick={() => { if (app.trim()) { void desktop('app.launch', { app: app.trim() }); setApp('') } }}
                  disabled={busy || !connected}
                  className="rounded-control bg-accent/15 px-2 text-accent hover:bg-accent/25 disabled:opacity-40"
                ><Send size={12} /></button>
              </div>
            </div>

            {/* 键盘注入 */}
            <div>
              <p className="mb-1.5 flex items-center gap-1 text-xs font-medium text-text-primary"><Keyboard size={12} className="text-accent" />键盘</p>
              <div className="flex gap-1">
                <input
                  value={keys}
                  onChange={(e) => setKeys(e.target.value)}
                  placeholder="按键，如 ctrl+s"
                  className="min-w-0 flex-1 rounded-control border border-border-subtle bg-bg-input px-2 py-1 text-xs text-text-primary outline-none placeholder:text-text-quaternary focus:border-accent/40"
                />
                <button onClick={() => { if (keys.trim()) { void desktop('key', { keys: keys.trim() }); setKeys('') } }}
                  disabled={busy || !connected}
                  className="rounded-control border border-border-subtle px-2 text-xs text-text-secondary hover:border-accent/40 hover:text-accent disabled:opacity-40"
                >发送</button>
              </div>
              <textarea
                value={typeText}
                onChange={(e) => setTypeText(e.target.value)}
                placeholder="输入文本后整段打入桌面"
                rows={2}
                className="mt-1.5 w-full resize-none rounded-control border border-border-subtle bg-bg-input px-2 py-1 text-xs text-text-primary outline-none placeholder:text-text-quaternary focus:border-accent/40"
              />
              <button onClick={() => { if (typeText) { void desktop('type', { text: typeText }); setTypeText('') } }}
                disabled={busy || !connected || !typeText}
                className="mt-1 w-full rounded-control bg-accent/15 py-1 text-xs text-accent hover:bg-accent/25 disabled:opacity-40"
              >打入文本</button>
            </div>

            {/* 窗口树 */}
            <div className="min-h-0 flex-1">
              <p className="mb-1.5 flex items-center gap-1 text-xs font-medium text-text-primary">
                <Radio size={12} className="text-accent" />窗口（{windows.length}）
              </p>
              {windows.length === 0 ? (
                <p className="py-3 text-caption text-text-muted">暂无窗口 — 先启动一个应用</p>
              ) : (
                <div className="flex flex-col gap-1">
                  {windows.map((w) => (
                    <button
                      key={w.id}
                      onClick={() => void desktop('window.op', { op: 'activate', window_id: w.id })}
                      className="group flex items-center gap-1 rounded-control px-1.5 py-1 text-left hover:bg-bg-hover"
                      title={`${w.id} · ${w.app || '未知应用'} @(${w.x},${w.y}) ${w.w}x${w.h}`}
                    >
                      <ChevronRight size={10} className="shrink-0 text-text-quaternary group-hover:text-accent" />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-xs text-text-primary">{w.title || w.id}</span>
                        <span className="block truncate text-caption text-text-muted">{w.app || '未知'}</span>
                      </span>
                    </button>
                  ))}
                </div>
              )}
            </div>

            <p className="text-caption text-text-tertiary">画面 = 主机 ffmpeg 实时流；点击/滚轮经 desktop-bus 纯 API 注入（fail-closed 审批外全部放行）</p>
          </div>
        </div>
      </div>
    </div>
  )
}
