/**
 * preload API 分部 — 窗口 / 对话框 / 剪贴板 / 确认 / 用户输入
 * 从 preload/index.ts 提取；由 index.ts 按原始键顺序展开合并
 */

import { ipcRenderer } from 'electron'

export const shellApi = {
  window: {
    minimize: (): Promise<void> => ipcRenderer.invoke('window:minimize'),
    maximize: (): Promise<void> => ipcRenderer.invoke('window:maximize'),
    close: (): Promise<void> => ipcRenderer.invoke('window:close'),
    isMaximized: (): Promise<boolean> => ipcRenderer.invoke('window:isMaximized'),
    ready: (): Promise<void> => ipcRenderer.invoke('window:ready'),
    onMaximizeChange: (callback: (isMaximized: boolean) => void): (() => void) => {
      const handler = (_event: unknown, isMaximized: boolean): void => callback(isMaximized)
      ipcRenderer.on('window:maximizeChange', handler as never)
      return () => ipcRenderer.removeListener('window:maximizeChange', handler as never)
    }
  },
  dialog: {
    openFolder: (): Promise<string | null> => ipcRenderer.invoke('dialog:openFolder'),
    openFile: (filters?: { name: string; extensions: string[] }[]): Promise<string[]> =>
      ipcRenderer.invoke('dialog:openFile', filters)
  },
  clipboard: {
    saveImage: (): Promise<string | null> => ipcRenderer.invoke('clipboard:saveImage'),
    deleteImages: (paths: string[]): Promise<{ success: boolean }> =>
      ipcRenderer.invoke('clipboard:deleteImages', paths)
  },
  confirm: {
    // 注意：这里只有推送/应答流（main 侧 chat-stream-handlers win.send('confirm:request') 推送、
    // ipcRenderer.send('confirm:response') 应答）。曾经还有一个 invoke('confirm:request')
    // 的请求-响应变体，但 main 侧从未注册对应 handler（调用必抛 No handler）且渲染层从未
    // 使用 —— 已由 IPC 通道契约测试（tests/integration/ipc-contract.test.ts）判定为死接口移除。
    onRequest: (callback: (data: { toolName: string; message: string }) => void): (() => void) => {
      const handler = (_event: unknown, data: { toolName: string; message: string }): void => callback(data)
      ipcRenderer.on('confirm:request', handler as never)
      return () => ipcRenderer.removeListener('confirm:request', handler as never)
    },
    respond: (confirmed: boolean): void => {
      ipcRenderer.send('confirm:response', confirmed)
    }
  },
  userInput: {
    onRequest: (callback: (data: { type: 'ask' | 'review'; title: string; content: string }) => void): (() => void) => {
      const handler = (_event: unknown, data: { type: 'ask' | 'review'; title: string; content: string }): void => callback(data)
      ipcRenderer.on('user-input:request', handler as never)
      return () => ipcRenderer.removeListener('user-input:request', handler as never)
    },
    respond: (data: { confirmed: boolean; response?: string }): void => {
      ipcRenderer.send('user-input:response', data)
    }
  },
}
