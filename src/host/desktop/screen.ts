/**
 * screen — ximo-OS 桌面画面采集（阶段 2 渲染端的数据源）
 *
 * 与本地 Agent 桌面（desktop-ops.ts）同一套 ffmpeg MJPEG 方案的**主机原生版**：
 * 不再经 wsl.exe 包装，直接在本机执行。画面流由 ffmpeg 以单客户端 listen 模式
 * 常驻（客户端断开即退出，下次请求时自愈重拉），server 的 /api/screen/stream
 * 把它代理给驾驶舱；/api/screen/snapshot 用 ImageMagick import 出单帧兜底。
 *
 * runner 可注入 — 单测用 fake 驱动同一套命令、几何查询与自愈逻辑。
 */
import { CMD, makeRunner, type RunFn } from './backend'

/** ffmpeg MJPEG 本地监听端口 — 仅回环，驾驶舱经 server 鉴权代理访问 */
export const SCREEN_STREAM_PORT = 18081

export interface ScreenDeps {
  display: string
  /** 屏幕尺寸（ffmpeg 采集参数，需与 Xvfb 一致） */
  width?: number
  height?: number
  run?: RunFn
  /** 截图留存目录（默认 /tmp/ximo-os-shots）— 供 vision_analyze 读取 */
  shotsDir?: string
}

export class ScreenCapture {
  private readonly run: RunFn
  /** 构造时的兜底尺寸 — 实际以查询到的显示器几何为准 */
  private readonly fallbackWidth: number
  private readonly fallbackHeight: number
  /** ffmpeg 当前采集尺寸 — 与显示器几何不一致时需重启流（否则画面被裁切） */
  private streamingSize: string | null = null
  private ensurePromise: Promise<void> | null = null

  /** 截图留存目录 — 视觉回路的关键：文件留存后 Agent 才能把路径交给 vision_analyze */
  private readonly shotsDir: string

  constructor(private readonly deps: ScreenDeps) {
    this.run = deps.run ?? makeRunner(deps.display)
    this.fallbackWidth = deps.width ?? 1280
    this.fallbackHeight = deps.height ?? 800
    this.shotsDir = deps.shotsDir ?? '/tmp/ximo-os-shots'
  }

  /** 确保画面流 ffmpeg 存活 — http listen 单次会话，客户端断开后退出，自愈式重拉 */
  async ensureStream(): Promise<void> {
    this.ensurePromise ??= this.doEnsure().finally(() => { this.ensurePromise = null })
    await this.ensurePromise
  }

  /** 显示器真实几何 — 查询失败退回构造参数（分辨率可在运行中改变） */
  private async displaySize(): Promise<{ width: number; height: number }> {
    try {
      const out = (await this.run('xdotool', ['getdisplaygeometry'])).trim().split(/\s+/)
      const width = Number(out[0])
      const height = Number(out[1])
      if (width > 0 && height > 0) return { width, height }
    } catch { /* 查询失败退回兜底 */ }
    return { width: this.fallbackWidth, height: this.fallbackHeight }
  }

  private async doEnsure(): Promise<void> {
    const { width, height } = await this.displaySize()
    const size = `${width}x${height}`

    try {
      const alive = await this.run('pgrep', ['-x', 'ffmpeg'])
      if (alive.trim()) {
        // 分辨率未变 → 复用现有流；变了 → 杀掉重启（x11grab 尺寸在启动时固定）
        if (this.streamingSize === size) return
        await this.run('pkill', ['-x', 'ffmpeg']).catch(() => {})
      }
    } catch { /* pgrep 无匹配时退出码非 0 — 视为 DEAD */ }

    // setsid 脱离会话 + 三流重定向（防管道占用与会话连带）；sleep 确保返回时已 listen
    const script =
      `setsid ffmpeg -f x11grab -framerate 10 -video_size ${size} ` +
      `-i ${this.deps.display} -c:v mjpeg -q:v 5 -f mpjpeg -listen 1 ` +
      `http://127.0.0.1:${SCREEN_STREAM_PORT}/stream </dev/null >>/tmp/ximo-os-ffmpeg.log 2>&1 & sleep 1.5; echo OK`
    await this.run('bash', ['-c', script], 15_000)
    this.streamingSize = size
  }

  /**
   * 单帧截图 — 返回 base64 data URL 与留存路径。
   * savedPath 是视觉回路的关键：Agent 需把可传递的路径交给 vision_analyze
   * （模型无法接收 base64 句柄）。24 小时前的旧截图自动清理防堆积。
   */
  async snapshot(): Promise<{ dataUrl: string; savedPath?: string } | null> {
    try {
      const name = `shot-${Date.now()}.png`
      const file = `${this.shotsDir}/${name}`
      await this.run('bash', ['-c', `mkdir -p ${this.shotsDir}`], 5000)
      await this.run('import', ['-window', 'root', file], 8000)
      const base64 = (await this.run('base64', ['-w0', file], 8000)).trim()
      if (!base64) return null
      // 顺手清理 24h 前的旧截图（失败不影响本次返回）
      void this.run('bash', ['-c', `find ${this.shotsDir} -name 'shot-*.png' -mmin +1440 -delete 2>/dev/null`], 5000).catch(() => {})
      return { dataUrl: `data:image/png;base64,${base64}`, savedPath: file }
    } catch {
      return null
    }
  }

  /** 拉起后的上游流地址 — server 代理管道的数据源 */
  get upstreamUrl(): string {
    return `http://127.0.0.1:${SCREEN_STREAM_PORT}/stream`
  }
}
