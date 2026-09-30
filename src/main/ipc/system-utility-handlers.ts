/**
 * 系统相关 IPC 处理器 — 系统字体、Checkpoint、DeepSeek Tokenizer、应用版本
 */

import { ipcMain, app } from 'electron'
import { getCheckpointStore, removeCheckpointStore } from '@main/CheckpointStore'

export function registerSystemUtilityHandlers(): void {
  // ---------- 系统字体 ----------
  ipcMain.handle('fonts:list', async () => {
    try {
      const { execSync } = await import('child_process')
      const ps = `Add-Type -AssemblyName System.Drawing; (New-Object System.Drawing.Text.InstalledFontCollection).Families | ForEach-Object { $_.Name }`
      const out = execSync(`powershell -NoProfile -Command "${ps}"`, { encoding: 'utf-8', timeout: 10000 })
      return out.split(/\r?\n/).map(f => f.trim()).filter(Boolean)
    } catch {
      return []
    }
  })

  // ---------- Checkpoint 系统 ----------
  ipcMain.handle('checkpoint:list', async (_event, sessionId: string) => {
    const store = getCheckpointStore(sessionId)
    return { success: true, checkpoints: store.list() }
  })
  ipcMain.handle('checkpoint:restore', async (_event, sessionId: string, fromTurn: number) => {
    const store = getCheckpointStore(sessionId)
    const result = await store.restoreCode(fromTurn)
    return { success: true, ...result }
  })
  ipcMain.handle('checkpoint:bounds', async (_event, sessionId: string) => {
    const store = getCheckpointStore(sessionId)
    const bounds: Record<number, number> = {}
    for (const [turn, idx] of store.bounds()) {
      bounds[turn] = idx
    }
    return { success: true, bounds }
  })
  ipcMain.handle('checkpoint:clear', async (_event, sessionId: string) => {
    await removeCheckpointStore(sessionId)
    return { success: true }
  })

  // ---------- DeepSeek Tokenizer ----------
  ipcMain.handle('tokenizer:count', async (_event, text: string) => {
    try {
      const { countTokens } = await import('@main/deepseek/tokenizer')
      return { success: true, count: countTokens(text) }
    } catch (e) {
      return { success: false, count: 0, error: (e as Error).message }
    }
  })
  ipcMain.handle('tokenizer:countMessages', async (_event, messages: { role: string; content: string }[]) => {
    try {
      const { countMessageTokens } = await import('@main/deepseek/tokenizer')
      return { success: true, count: countMessageTokens(messages) }
    } catch (e) {
      return { success: false, count: 0, error: (e as Error).message }
    }
  })

  // ---------- 获取应用版本 ----------
  ipcMain.handle('app:getVersion', () => app.getVersion())
}
