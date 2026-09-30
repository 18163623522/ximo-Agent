import { useEffect, useState, useCallback } from 'react'
import { Monitor, Play, Square, RefreshCw, AlertCircle, RotateCw } from 'lucide-react'
import { WorkspaceStage } from './WorkspaceStage'

/**
 * AgentWorkspacePanel — WSL 隔离桌面面板（右侧栏）
 *
 * 只负责桌面的启停与实时画面展示。任务指令不在这里输入 ——
 * 用户在主聊天输入框用 @Agent系统桌面 提及即可把任务路由给桌面 Agent
 * （见 buildUserMessage 的桌面提及处理），执行过程在主聊天流可视化。
 *
 * 自动引导：用户只需点"启动"，自动检测/安装 WSL + Debian + 依赖。
 * 唯一需要人工介入：首次启用 WSL 功能后需要重启（一次性）。
 */

/** 引导阶段 → 中文描述 */
const STAGE_LABELS: Record<string, string> = {
  idle: '',
  checking_wsl: '检测 WSL 环境',
  enabling_wsl: '启用 WSL 功能',
  installing_distro: '下载安装 Debian',
  first_boot: '初始化 Debian',
  installing_deps: '安装桌面依赖',
  starting_desktop: '启动虚拟桌面',
  ready: '就绪',
  needs_reboot: '需要重启',
  error: '错误',
}

export function AgentWorkspacePanel(): React.ReactElement {
  // 画面状态
  const [running, setRunning] = useState(false)
  const [streamAvailable, setStreamAvailable] = useState(false)
  const [streamFailed, setStreamFailed] = useState(false)
  const [screenshot, setScreenshot] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [needsReboot, setNeedsReboot] = useState(false)
  const [setupStage, setSetupStage] = useState<string>('idle')
  const [setupMessage, setSetupMessage] = useState<string>('')

  /** 实时流是否生效 — 流失败后回退快照轮询，重启时恢复 */
  const streamActive = running && streamAvailable && !streamFailed

  const pollScreenshot = useCallback(async () => {
    if (!running) return
    const result = await window.api.workspace.screenshot()
    if (result.success && result.screenshot) {
      setScreenshot(result.screenshot)
    }
  }, [running])

  // 启动时检查状态
  useEffect(() => {
    void checkState()
  }, [])

  // 监听引导进度
  useEffect(() => {
    const cleanup = window.api.workspace.onProgress((data) => {
      setSetupStage(data.stage)
      setSetupMessage(data.message)
      if (data.stage === 'needs_reboot') {
        setNeedsReboot(true)
      }
      if (data.stage === 'ready') {
        setNeedsReboot(false)
      }
    })
    return cleanup
  }, [])

  // 快照轮询 — 仅在无实时流时启用（有流时 ffmpeg 持续推帧，无需轮询）
  useEffect(() => {
    if (!running || streamActive) return
    const timer = setInterval(() => void pollScreenshot(), 800)
    return () => clearInterval(timer)
  }, [running, streamActive, pollScreenshot])

  // 实时流失败后每 10 秒重试一次 — 成功则自动回到「实时」，失败继续快照轮询
  useEffect(() => {
    if (!running || !streamAvailable || !streamFailed) return
    const timer = setInterval(() => setStreamFailed(false), 10_000)
    return () => clearInterval(timer)
  }, [running, streamAvailable, streamFailed])

  const checkState = async (): Promise<void> => {
    const state = await window.api.workspace.state()
    setRunning(state.running)
    setError(state.error)
    setStreamAvailable(state.streamAvailable ?? false)
    if (state.lastScreenshot) setScreenshot(state.lastScreenshot)
    if (state.setupStage) setSetupStage(state.setupStage)
    if (state.setupMessage) setSetupMessage(state.setupMessage)
    if (state.setupStage === 'needs_reboot') setNeedsReboot(true)
  }

  const handleStart = async (): Promise<void> => {
    setLoading(true)
    setError(null)
    setNeedsReboot(false)
    setStreamFailed(false)
    const result = await window.api.workspace.start()
    setRunning(result.running)
    setError(result.error)
    setStreamAvailable(result.streamAvailable ?? false)
    setSetupStage(result.setupStage)
    setSetupMessage(result.setupMessage)
    if (result.setupStage === 'needs_reboot') {
      setNeedsReboot(true)
    }
    setLoading(false)
  }

  const handleStop = async (): Promise<void> => {
    setLoading(true)
    await window.api.workspace.stop()
    setRunning(false)
    setStreamAvailable(false)
    setStreamFailed(false)
    setScreenshot(null)
    setSetupStage('idle')
    setLoading(false)
  }

  const handleRefresh = async (): Promise<void> => {
    await pollScreenshot()
  }

  // 点击画面 — 换算为 1280x800 桌面坐标后投递点击
  const handleCanvasClick = async (e: React.MouseEvent<HTMLImageElement>): Promise<void> => {
    if (!running) return
    const img = e.currentTarget
    const rect = img.getBoundingClientRect()
    const scaleX = 1280 / rect.width
    const scaleY = 800 / rect.height
    const x = Math.round((e.clientX - rect.left) * scaleX)
    const y = Math.round((e.clientY - rect.top) * scaleY)
    await window.api.workspace.click(x, y)
    setTimeout(() => void pollScreenshot(), 300)
  }

  const stageLabel = STAGE_LABELS[setupStage] || setupStage

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* 顶栏 */}
      <div className="flex items-center gap-1 border-b border-border-subtle px-2 py-1.5 shrink-0">
        <Monitor size={13} className="text-accent shrink-0" />
        <span className="text-xs font-medium text-text-secondary flex-1">Agent 桌面</span>
        {running ? (
          <span className="flex items-center gap-1 text-caption text-state-success">
            <span className="h-1.5 w-1.5 rounded-full bg-state-success animate-pulse" />
            {streamActive ? '实时' : '运行中'}
          </span>
        ) : (
          <span className="text-caption text-text-muted">未启动</span>
        )}
        <button
          onClick={() => void handleRefresh()}
          disabled={!running || loading}
          className="icon-btn rounded-control p-1 disabled:opacity-40"
          title="刷新画面"
        >
          <RefreshCw size={11} />
        </button>
        {running ? (
          <button
            onClick={() => void handleStop()}
            disabled={loading}
            className="icon-btn rounded-control p-1 text-state-error hover:bg-state-error/10 disabled:opacity-40"
            title="停止"
          >
            <Square size={11} />
          </button>
        ) : (
          <button
            onClick={() => void handleStart()}
            disabled={loading}
            className="icon-btn rounded-control p-1 text-state-success hover:bg-state-success/10 disabled:opacity-40"
            title="启动"
          >
            <Play size={11} />
          </button>
        )}
      </div>

      {/* 错误提示 */}
      {error && !needsReboot && (
        <div className="flex items-center gap-2 px-3 py-2 bg-state-error/10 border-b border-state-error/20 shrink-0">
          <AlertCircle size={12} className="text-state-error shrink-0" />
          <span className="text-caption text-state-error flex-1 truncate">{error}</span>
        </div>
      )}

      {/* 需要重启提示 */}
      {needsReboot && !running && (
        <div className="flex items-center gap-2 px-3 py-2 bg-state-warning/10 border-b border-state-warning/20 shrink-0">
          <RotateCw size={12} className="text-state-warning shrink-0" />
          <span className="text-caption text-state-warning flex-1">
            WSL 功能已启用，需要重启电脑才能生效。重启后再次点击启动。
          </span>
        </div>
      )}

      {/* 画面区 / 启动进度 */}
      <WorkspaceStage
        running={running}
        loading={loading}
        needsReboot={needsReboot}
        streamActive={streamActive}
        screenshot={screenshot}
        stageLabel={stageLabel}
        setupStage={setupStage}
        setupMessage={setupMessage}
        onStart={() => void handleStart()}
        onCanvasClick={(e) => void handleCanvasClick(e)}
        onStreamError={() => setStreamFailed(true)}
      />
    </div>
  )
}
