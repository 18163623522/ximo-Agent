import { contextBridge, ipcRenderer } from 'electron'
import { extendedApi } from './extended-api'
import { chatApi } from '../shared/preload-api/chat'
import { dataApi } from '../shared/preload-api/data'
import { shellApi } from '../shared/preload-api/shell'
import { filesApi } from '../shared/preload-api/files'
import { browserApi } from '../shared/preload-api/browser'
import { computerApi } from '../shared/preload-api/computer'
import { agentApi } from '../shared/preload-api/agent'
import { hostApi } from '../shared/preload-api/host'

// 通过 contextBridge 暴露安全的 API 给渲染进程
// 内聚 API 组拆分至 ../shared/preload-api/，此处按原始键顺序展开合并（行为与类型不变）
const api = {
  ...chatApi,
  ...dataApi,
  ...shellApi,
  ...filesApi,
  ...browserApi,
  ...computerApi,
  ...agentApi,
  ...hostApi,
  // 系统字体列表
  fonts: {
    list: (): Promise<string[]> => ipcRenderer.invoke('fonts:list')
  },
  ...extendedApi,

  // 获取应用版本
  getVersion: (): Promise<string> => ipcRenderer.invoke('app:getVersion'),
  // DeepSeek V4 分词器 — 本地 token 计数（与 API 口径一致）
  tokenizer: {
    count: (text: string): Promise<{ success: boolean; count: number; error?: string }> =>
      ipcRenderer.invoke('tokenizer:count', text),
    countMessages: (messages: { role: string; content: string }[]): Promise<{ success: boolean; count: number; error?: string }> =>
      ipcRenderer.invoke('tokenizer:countMessages', messages)
  },

  // 语音转写已在 extendedApi 中定义
}

export type Api = typeof api

if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('api', api)
  } catch (error) {
    console.error(error)
  }
} else {
  // @ts-ignore 类型绕过
  window.api = api
}
