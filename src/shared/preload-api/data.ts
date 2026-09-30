/**
 * preload API 分部 — 设置 / 会话 / 技能 / MCP / 服务商 / 导入技能
 * 从 preload/index.ts 提取；由 index.ts 按原始键顺序展开合并
 */

import { ipcRenderer } from 'electron'
import type { AppSettings, Conversation, Skill, RecordingSession, McpServerConfig, ImportedSkill } from '@shared/types'

export const dataApi = {
  settings: {
    load: (): Promise<AppSettings> => ipcRenderer.invoke('settings:load'),
    save: (settings: AppSettings): Promise<boolean> =>
      ipcRenderer.invoke('settings:save', settings)
  },
  conversations: {
    load: (): Promise<Conversation[]> => ipcRenderer.invoke('conversations:load'),
    save: (conversations: Conversation[]): Promise<boolean> =>
      ipcRenderer.invoke('conversations:save', conversations)
  },
  skills: {
    load: (): Promise<Skill[]> => ipcRenderer.invoke('skills:load'),
    save: (skills: Skill[]): Promise<boolean> => ipcRenderer.invoke('skills:save', skills),
    recordingStatus: (): Promise<{ isRecording: boolean; session: RecordingSession | null; rrwebEventCount: number }> =>
      ipcRenderer.invoke('skills:recordingStatus'),
    startRecording: (url?: string): Promise<RecordingSession> =>
      ipcRenderer.invoke('skills:startRecording', url),
    stopRecording: (): Promise<RecordingSession | null> =>
      ipcRenderer.invoke('skills:stopRecording'),
    appendRrwebEvent: (event: Record<string, unknown>): void => {
      ipcRenderer.send('skill:append-rrweb-event', event)
    }
  },
  mcp: {
    load: (): Promise<McpServerConfig[]> => ipcRenderer.invoke('mcp:load'),
    save: (servers: McpServerConfig[]): Promise<boolean> => ipcRenderer.invoke('mcp:save', servers),
    parseConfig: (raw: string): Promise<{ servers: McpServerConfig[]; error?: string }> =>
      ipcRenderer.invoke('mcp:parseConfig', raw)
  },
  // 自定义服务商 — 自动获取模型列表（OpenAI 兼容 GET /models）
  providers: {
    listModels: (baseUrl: string, apiKey: string): Promise<{ success: boolean; models: string[]; error?: string }> =>
      ipcRenderer.invoke('providers:list-models', baseUrl, apiKey)
  },
  importedSkills: {
    load: (): Promise<ImportedSkill[]> => ipcRenderer.invoke('imported-skills:load'),
    save: (skills: ImportedSkill[]): Promise<boolean> => ipcRenderer.invoke('imported-skills:save', skills),
    parseMarkdown: (raw: string): Promise<{ name: string; description: string; triggers: string[]; body: string; error?: string }> =>
      ipcRenderer.invoke('imported-skills:parseMarkdown', raw)
  },
}
