import { app, BrowserWindow, protocol, net } from 'electron'
import { pathToFileURL } from 'url'
import { configureGpuAcceleration } from './gpu-config'
import { createWindow } from './window-manager'
import { registerChatHandlers } from './ipc/chat-handler'
import { registerUpdateHandlers } from './ipc/update-handlers'
import { registerFsHandlers } from './ipc/fs-handlers'
import { registerNetworkHandlers } from './ipc/network-handlers'
import { registerDataHandlers } from './ipc/data-handlers'
import { registerSystemHandlers } from './ipc/system-handlers'
import { registerVoiceHandlers } from './voice/voice-ipc'
import { registerXimoHostCamProtocol } from './host/cam-protocol'
import { WSL_STREAM_URL, agentWorkspaceManager } from './tools/AgentWorkspace/AgentWorkspaceManager'
// 内嵌浏览器 IPC 桥 — 模块加载时注册 handler，必须在启动时导入，
// 否则用户打开内置浏览器时 'embedded-browser:set-active' 尚未注册导致报错
import './tools/Browser/WebviewBridge'

// ---------- GPU 硬件加速 ----------
// 必须在 app.whenReady() 之前设置
configureGpuAcceleration()

// ---------- 注册自定义协议 ----------
// 必须在 app.whenReady() 之前注册 scheme
protocol.registerSchemesAsPrivileged([
  { scheme: 'ximobg', privileges: { bypassCSP: true, stream: true, supportFetchAPI: true } },
  // WSL 隔离桌面实时画面流（ffmpeg MJPEG 长连接分帧）— bypassCSP 绕过 img-src 限制
  { scheme: 'wslcam', privileges: { bypassCSP: true, stream: true, supportFetchAPI: true } },
  // ximo-OS 主机画面流（同 wslcam 方案，数据源为远程主机的 /api/screen/stream）
  { scheme: 'ximo-host-cam', privileges: { bypassCSP: true, stream: true, supportFetchAPI: true } },
])

// ---------- 注册 IPC 处理器 ----------
registerChatHandlers()
registerFsHandlers()
registerNetworkHandlers()
registerUpdateHandlers()
registerDataHandlers()
registerSystemHandlers()
registerVoiceHandlers()

// 全局异常兜底，防止未捕获异常导致应用崩溃
process.on('uncaughtException', (error) => {
  console.error('[Main] Uncaught Exception:', error)
})
process.on('unhandledRejection', (reason) => {
  console.error('[Main] Unhandled Rejection:', reason)
})

app.whenReady().then(() => {
  // 注册 ximobg:// 协议处理器 — 用于渲染进程加载本地背景图
  // URL 格式: ximobg://bg/<encodeURIComponent(文件路径)>
  protocol.handle('ximobg', (request) => {
    const urlObj = new URL(request.url)
    const filePath = decodeURIComponent(urlObj.pathname.slice(1))
    return net.fetch(pathToFileURL(filePath).href)
  })

  // 注册 wslcam:// 协议处理器 — 代理 WSL 内 ffmpeg MJPEG 实时画面流
  // 1. 每次请求先确保 ffmpeg 存活（http listen 单次会话，客户端断开后退出，自愈式重拉）
  // 2. 重写 Content-Type — ffmpeg 恒发 application/octet-stream，
  //    Chromium <img> 只有收到 multipart/x-mixed-replace 才会逐帧渲染
  // 工作区未启动时返回 503，面板 onError 自动回退快照模式
  protocol.handle('wslcam', async () => {
    try {
      await agentWorkspaceManager.ensureStreamRunning()
      const upstream = await net.fetch(WSL_STREAM_URL)
      return new Response(upstream.body, {
        status: 200,
        headers: {
          'Content-Type': 'multipart/x-mixed-replace; boundary=ffmpeg',
          'Cache-Control': 'no-store',
        },
      })
    } catch (e) {
      console.warn('[wslcam] 画面流代理失败:', (e as Error).message)
      return new Response('Agent 桌面画面流未就绪', { status: 503 })
    }
  })

  // 注册 ximo-host-cam:// 协议处理器 — 代理 ximo-OS 主机画面流（渲染端之一）
  registerXimoHostCamProtocol()

  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow()
    }
  })
})

app.on('before-quit', async () => {
  // 确保防抖中的会话数据落盘，避免退出时丢失最后 500ms 的变更
  try {
    const { flushSaveConversations } = await import('./store')
    await flushSaveConversations()
  } catch { /* ignore */ }
})

app.on('window-all-closed', () => {
  // 关闭 pi-computer-use Helper
  import('./tools/ComputerUse/PiBridge').then(({ piBridge }) => piBridge.dispose()).catch(() => {})
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
