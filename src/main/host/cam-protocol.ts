/**
 * ximo-host-cam:// — ximo-OS 主机画面流协议（渲染端代理）
 *
 * 与本地 Agent 桌面的 wslcam:// 同构：渲染层 <img src="ximo-host-cam://stream">，
 * 主进程代理主机的 /api/screen/stream（Bearer 鉴权），并重写 Content-Type ——
 * ffmpeg 恒发 application/octet-stream，Chromium <img> 只有收到
 * multipart/x-mixed-replace 才会逐帧渲染。未配置主机时返回 503，面板回退快照。
 */
import { protocol } from 'electron'
import { loadSettings } from '../store'
import { restUrl } from './HostClient'

export const CAM_STREAM_URL = 'ximo-host-cam://stream'

/** 注册协议（app.ready 前声明 scheme，ready 后调用本函数挂 handler） */
export function registerXimoHostCamProtocol(): void {
  protocol.handle('ximo-host-cam', async () => {
    try {
      const s = await loadSettings()
      if (!s.hostUrl || !s.hostToken) {
        return new Response('未配置 ximo-OS 主机', { status: 503 })
      }
      const upstream = await fetch(`${restUrl(s.hostUrl, '')}/api/screen/stream`, {
        headers: { Authorization: `Bearer ${s.hostToken}` },
      })
      if (!upstream.ok) {
        return new Response(`主机画面流不可用（${upstream.status}）`, { status: 503 })
      }
      return new Response(upstream.body, {
        status: 200,
        headers: {
          'Content-Type': 'multipart/x-mixed-replace; boundary=ffmpeg',
          'Cache-Control': 'no-store',
        },
      })
    } catch (e) {
      console.warn('[ximo-host-cam] 画面流代理失败:', (e as Error).message)
      return new Response('ximo-OS 主机画面流未就绪', { status: 503 })
    }
  })
}
