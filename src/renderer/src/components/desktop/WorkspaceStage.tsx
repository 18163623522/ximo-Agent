import { lazy, Suspense, useState } from 'react'
import { Monitor, Play, Loader2, RotateCw, Maximize2 } from 'lucide-react'

const ScreenshotPreview = lazy(() =>
  import('@renderer/components/ScreenshotPreview').then((m) => ({ default: m.ScreenshotPreview }))
)

/** wslcam:// 协议由主进程注册（src/main/index.ts），代理 WSL 内 ffmpeg MJPEG 实时画面流 */
const STREAM_URL = 'wslcam://stream'

interface WorkspaceStageProps {
  running: boolean
  loading: boolean
  needsReboot: boolean
  /** 实时流是否生效（不可用或加载失败时回退快照） */
  streamActive: boolean
  /** 最新快照（回退模式轮询得到） */
  screenshot: string | null
  stageLabel: string
  setupStage: string
  setupMessage: string
  onStart: () => void
  /** 点击画面 — 换算坐标后在 WSL 桌面执行点击 */
  onCanvasClick: (e: React.MouseEvent<HTMLImageElement>) => void
  /** 实时流加载失败 — 通知父组件切换到快照轮询 */
  onStreamError: () => void
}

/**
 * WorkspaceStage — WSL 隔离桌面的画面区子组件
 *
 * 渲染优先级：引导进度 > 实时流（wslcam://）> 快照 > 空态。
 * 右上角放大按钮截取当前帧进 ScreenshotPreview 灯箱 — 用静态帧，
 * 不占用 mpjpeg 单客户端流连接（面板的 <img> 是唯一流消费者）。
 */
export function WorkspaceStage({
  running, loading, needsReboot, streamActive, screenshot,
  stageLabel, setupStage, setupMessage, onStart, onCanvasClick, onStreamError,
}: WorkspaceStageProps): React.ReactElement {
  const [lightboxUrl, setLightboxUrl] = useState<string | null>(null)
  const [enlarging, setEnlarging] = useState(false)

  const handleEnlarge = async (): Promise<void> => {
    if (enlarging) return
    setEnlarging(true)
    try {
      const result = await window.api.workspace.screenshot()
      if (result.success && result.screenshot) setLightboxUrl(result.screenshot)
    } finally {
      setEnlarging(false)
    }
  }

  let body: React.ReactNode
  if (loading) {
    body = (
      <div className="flex flex-col items-center gap-3 text-text-muted px-4">
        <Loader2 size={24} className="animate-spin text-accent" />
        <div className="text-center">
          <p className="text-xs text-text-secondary">{stageLabel || '处理中…'}</p>
          {setupMessage && (
            <p className="text-caption text-text-muted mt-1 max-w-[220px]">{setupMessage}</p>
          )}
          {setupStage === 'enabling_wsl' && (
            <p className="text-caption text-state-warning mt-1">⚠️ 如果弹出 UAC 窗口，请点击"是"确认</p>
          )}
        </div>
        <div className="w-40 h-1 bg-bg-hover rounded-full overflow-hidden">
          <div className="h-full bg-accent animate-pulse" style={{ width: '60%' }} />
        </div>
      </div>
    )
  } else if (running && streamActive) {
    body = (
      <img
        src={STREAM_URL}
        alt="Agent Desktop"
        onClick={onCanvasClick}
        onError={onStreamError}
        draggable={false}
        className="max-w-full max-h-full object-contain cursor-pointer"
      />
    )
  } else if (screenshot) {
    body = (
      <img
        src={screenshot}
        alt="Agent Desktop"
        onClick={onCanvasClick}
        draggable={false}
        className="max-w-full max-h-full object-contain cursor-pointer"
      />
    )
  } else {
    body = (
      <div className="flex flex-col items-center gap-3 text-text-muted px-4">
        <Monitor size={32} className="opacity-30" />
        <div className="text-center">
          <p className="text-xs text-text-secondary">WSL 隔离 Linux 桌面</p>
          <p className="text-caption text-text-muted mt-1">
            {running ? '正在获取画面…' : needsReboot ? '请重启电脑后点击启动' : '点击下方按钮一键启动'}
          </p>
        </div>
        {!running && (
          <button
            onClick={onStart}
            disabled={loading}
            className="flex items-center gap-1.5 rounded-control bg-accent/15 px-3 py-1.5 text-xs text-accent hover:bg-accent/25 transition-colors disabled:opacity-40"
          >
            <Play size={12} />
            {needsReboot ? '我已重启，继续' : '一键启动'}
          </button>
        )}
      </div>
    )
  }

  return (
    <div className="relative min-h-0 flex-1 overflow-hidden bg-black flex items-center justify-center">
      {body}
      {running && !loading && (
        <button
          onClick={() => void handleEnlarge()}
          disabled={enlarging}
          className="absolute right-2 top-2 z-10 icon-btn rounded-control bg-black/50 p-1.5 text-white/90 hover:bg-black/70 disabled:opacity-40"
          title="放大查看"
        >
          {enlarging ? <Loader2 size={13} className="animate-spin" /> : <Maximize2 size={13} />}
        </button>
      )}
      {lightboxUrl && (
        <Suspense fallback={null}>
          <ScreenshotPreview dataUrl={lightboxUrl} onClose={() => setLightboxUrl(null)} />
        </Suspense>
      )}
    </div>
  )
}
