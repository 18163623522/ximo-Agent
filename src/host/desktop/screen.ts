/**
 * screen — ximo-OS 桌面画面采集（阶段 2 渲染端的数据源）
 *
 * 与本地 Agent 桌面（desktop-ops.ts）同一套 ffmpeg MJPEG 方案的**主机原生版**：
 * 不再经 wsl.exe 包装，直接在本机执行。画面流由 ffmpeg 以单客户端 listen 模式
 * 常驻（客户端断开即退出，下次请求时自愈重拉），server 的 /api/screen/stream
 * 把它代理给驾驶舱；/api/screen/snapshot 用 ImageMagick import 出单帧兜底。
 *
 * runner/spawner 可注入 — 单测用 fake 驱动同一套命令与自愈逻辑。
 */
import { spawn } from 'child_process'
import { CMD, makeRunner, type RunFn } from './backend'

/** ffmpeg MJPEG 本地监听端口 — 仅回环，驾驶舱经 server 鉴权代理访问 */
export const SCREEN_STREAM_PORT = 18081

export interface ScreenDeps {
  display: string
  /** 屏幕尺寸（ffmpeg 采集参数，需与 Xvfb 一致） */
  width?: number
  height?: number
  run?: RunFn
  spawn?: typeof spawn
}

export class ScreenCapture {
  private readonly run: RunFn
  private readonly spawnFn: typeof spawn
  private readonly width: number
  private readonly height: number
  private ensurePromise: Promise<void> | null = null

  constructor(private readonly deps: ScreenDeps) {
    this.run = deps.run ?? makeRunner(deps.display)
    this.spawnFn = deps.spawn ?? spawn
    this.width = deps.width ?? 1280
    this.height = deps.height ?? 800
  }

  /** 确保画面流 ffmpeg 存活 — http listen 单次会话，客户端断开后退出，自愈式重拉 */
  async ensureStream(): Promise<void> {
    this.ensurePromise ??= this.doEnsure().finally(() => { this.ensurePromise = null })
    await this.ensurePromise
  }

  private async doEnsure(): Promise<void> {
    try {
      const alive = await this.run('pgrep', ['-x', 'ffmpeg'])
      if (alive.trim()) return
    } catch { /* pgrep 无匹配时退出码非 0 — 视为 DEAD */ }
    // setsid 脱离会话 + 三流重定向（防管道占用与会话连带）；sleep 确保返回时已 listen
    const script =
      `setsid ffmpeg -f x11grab -framerate 10 -video_size ${this.width}x${this.height} ` +
      `-i ${this.deps.display} -c:v mjpeg -q:v 5 -f mpjpeg -listen 1 ` +
      `http://127.0.0.1:${SCREEN_STREAM_PORT}/stream </dev/null >>/tmp/ximo-os-ffmpeg.log 2>&1 & sleep 1.5; echo OK`
    await this.run('bash', ['-c', script], 15_000)
  }

  /** 单帧截图 — 返回 base64 data URL；流不可用时的兜底渲染源 */
  async snapshot(): Promise<string | null> {
    try {
      const tmp = `/tmp/ximo-os-screen-${Date.now()}.png`
      await this.run('import', ['-window', 'root', tmp], 8000)
      const base64 = (await this.run('base64', ['-w0', tmp], 8000)).trim()
      void this.run('bash', ['-c', `rm -f "${tmp}"`]).catch(() => {})
      return base64 ? `data:image/png;base64,${base64}` : null
    } catch {
      return null
    }
  }

  /** 拉起后的上游流地址 — server 代理管道的数据源 */
  get upstreamUrl(): string {
    return `http://127.0.0.1:${SCREEN_STREAM_PORT}/stream`
  }
}
