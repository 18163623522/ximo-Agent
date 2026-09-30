/**
 * 聊天流取消 IPC 处理器 — 支持按会话 ID 取消（多会话并行）
 */

import { ipcMain } from 'electron'
import { sessionControllers, getDefaultController, setDefaultController } from './chat-stream-handlers'

export function registerChatCancelHandlers(): void {
  // 取消流式请求 — 支持按会话 ID 取消（多会话并行）
  ipcMain.handle('chat:cancel', (_event, sessionId?: string) => {
    if (sessionId) {
      const controller = sessionControllers.get(sessionId)
      if (controller) {
        controller.abort()
        sessionControllers.delete(sessionId)
      }
    } else {
      // 无 sessionId — 取消默认 controller
      const controller = getDefaultController()
      if (controller) {
        controller.abort()
        setDefaultController(null)
      }
    }
  })
}
