/**
 * preload API 分部 — 流式聊天
 * 从 preload/index.ts 提取；由 index.ts 按原始键顺序展开合并
 */

import { ipcRenderer } from 'electron'
import type { ChatRequest, StreamChunk, TestResult } from '@shared/types'

export const chatApi = {
  // 流式聊天：注册 chunk 回调，返回 Promise（结束时 resolve）
  chat: {
    stream: (
      request: ChatRequest,
      onChunk: (chunk: StreamChunk) => void
    ): Promise<void> => {
      let removed = false
      const handler = (_event: unknown, chunk: StreamChunk): void => {
        onChunk(chunk)
        // 收到 done 时立即移除监听器，避免 IPC 竞态导致 done 丢失
        // （Electron 中 invoke 响应和 send 消息走不同内部通道，finally 可能提前触发）
        if (chunk.done && !removed) {
          removed = true
          ipcRenderer.removeListener('chat:chunk', handler as never)
        }
      }
      ipcRenderer.on('chat:chunk', handler as never)
      return ipcRenderer
        .invoke('chat:start', request)
        .finally(() => {
          // 安全网：done 未到达或异常时清理
          if (!removed) {
            removed = true
            ipcRenderer.removeListener('chat:chunk', handler as never)
          }
        })
    },
    cancel: (sessionId?: string): Promise<void> => ipcRenderer.invoke('chat:cancel', sessionId),
    test: (apiKey: string, baseUrl: string, model: string, providerId?: string): Promise<TestResult> =>
      ipcRenderer.invoke('chat:test', apiKey, baseUrl, model, providerId),
    enhancePrompt: (data: { text: string; mode: string; recentContext?: string; projectPath?: string }): Promise<{ success: boolean; enhancedText?: string; error?: string }> =>
      ipcRenderer.invoke('chat:enhance-prompt', data)
  },
}
