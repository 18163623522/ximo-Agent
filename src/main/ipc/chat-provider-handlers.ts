/**
 * 聊天服务商相关 IPC 处理器 — 连接测试、自动获取模型列表
 */

import { ipcMain } from 'electron'
import { testConnection } from '@main/deepseek'
import { resolveActiveProvider } from '@main/deepseek/provider'
import { loadSettings } from '@main/store'

export function registerChatProviderHandlers(): void {
  // 连接测试
  ipcMain.handle('chat:test', async (_event, apiKey: string, baseUrl: string, model: string, providerId?: string) => {
    if (providerId) {
      const settings = await loadSettings()
      const provider = resolveActiveProvider(settings, providerId)
      const cfgModels = (settings.providers ?? []).find((p) => p.id === providerId)?.models ?? []
      const testModel = model || cfgModels[0] || 'gpt-4o-mini'
      return testConnection(provider.apiKey, provider.baseUrl, testModel)
    }
    return testConnection(apiKey, baseUrl, model)
  })

  // 自动获取模型列表
  ipcMain.handle('providers:list-models', async (_event, baseUrl: string, apiKey: string) => {
    if (!baseUrl || !baseUrl.trim()) {
      return { success: false, models: [] as string[], error: '请先填写 Base URL' }
    }
    const url = `${baseUrl.trim().replace(/\/$/, '')}/models`
    try {
      const response = await fetch(url, {
        headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
        signal: AbortSignal.timeout(15_000)
      })
      if (!response.ok) {
        return { success: false, models: [], error: `获取失败 (${response.status})：请检查 Base URL 与 API Key` }
      }
      const data = await response.json()
      const list: string[] = Array.isArray(data?.data)
        ? data.data
            .map((m: { id?: unknown }) => (typeof m?.id === 'string' ? m.id : ''))
            .filter(Boolean)
        : []
      list.sort()
      return { success: true, models: list, error: list.length === 0 ? '该端点未返回模型列表，请手动填写' : undefined }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      return { success: false, models: [], error: `网络错误：${msg}` }
    }
  })
}
