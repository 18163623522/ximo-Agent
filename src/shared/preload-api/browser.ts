/**
 * preload API 分部 — 内嵌浏览器抓包 / 桥接 / 技能录制 / 设计组件库
 * 从 preload/index.ts 提取；由 index.ts 按原始键顺序展开合并
 */

import { ipcRenderer } from 'electron'
import type { CapturedRequest, Skill } from '@shared/types'

export const browserApi = {
  // 内嵌浏览器网络抓包
  networkCapture: {
    start: (): Promise<{ success: boolean }> => ipcRenderer.invoke('network-capture:start'),
    stop: (): Promise<{ success: boolean }> => ipcRenderer.invoke('network-capture:stop'),
    getRequests: (): Promise<CapturedRequest[]> => ipcRenderer.invoke('network-capture:get'),
    clear: (): Promise<{ success: boolean }> => ipcRenderer.invoke('network-capture:clear')
  },
  // 内嵌浏览器桥 — Agent ↔ webview 命令通道
  embeddedBrowser: {
    setActive: (active: boolean): Promise<{ success: boolean }> =>
      ipcRenderer.invoke('embedded-browser:set-active', active),
    onCommand: (callback: (data: { id: string; cmd: string; args: Record<string, unknown> }) => void): (() => void) => {
      const handler = (_event: unknown, data: { id: string; cmd: string; args: Record<string, unknown> }): void => callback(data)
      ipcRenderer.on('webview:command', handler as never)
      return () => ipcRenderer.removeListener('webview:command', handler as never)
    },
    sendResult: (data: { id: string; success: boolean; result?: unknown; error?: string }): void => {
      ipcRenderer.send('webview:result', data)
    }
  },
  // 技能录制保存（内嵌浏览器模式）
  skillRecording: {
    save: (data: {
      name: string
      description: string
      steps: Array<{ tool: string; arguments: Record<string, unknown>; timestamp: number; description?: string }>
      apiEndpoints: string[]
      startUrl?: string
      rrwebEvents?: Record<string, unknown>[]
    }): Promise<{ success: boolean; skill: Skill }> =>
      ipcRenderer.invoke('skill-recording:save', data)
  },
  // 设计组件库 — 读取 react-bits 组件源码（JSX + CSS）
  design: {
    readComponent: (category: string, componentId: string): Promise<{ success: boolean; jsx: string; css: string; error?: string }> =>
      ipcRenderer.invoke('design:readComponent', category, componentId)
  },
}
