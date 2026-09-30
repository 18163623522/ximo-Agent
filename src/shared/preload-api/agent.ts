/**
 * preload API 分部 — 定时任务 / Agent 系统 / 工作分摊
 * 从 preload/index.ts 提取；由 index.ts 按原始键顺序展开合并
 */

import { ipcRenderer } from 'electron'
import type { AgentSchedule, ScheduleDraft } from '@shared/agent-schedule'
import type { AgentDefinition, AgentInstance } from '@shared/agent-definition'

export const agentApi = {
  // Agent 定时任务
  schedules: {
    list: (): Promise<{ success: boolean; schedules: AgentSchedule[] }> =>
      ipcRenderer.invoke('schedule:list'),
    create: (draft: ScheduleDraft): Promise<{ success: boolean; schedule?: AgentSchedule; message?: string }> =>
      ipcRenderer.invoke('schedule:create', draft),
    update: (id: string, draft: ScheduleDraft): Promise<{ success: boolean; schedule?: AgentSchedule; message?: string }> =>
      ipcRenderer.invoke('schedule:update', id, draft),
    delete: (id: string): Promise<{ success: boolean }> =>
      ipcRenderer.invoke('schedule:delete', id),
    getPaused: (): Promise<{ paused: boolean }> =>
      ipcRenderer.invoke('schedule:getPaused'),
    setPaused: (paused: boolean): Promise<{ success: boolean; paused: boolean }> =>
      ipcRenderer.invoke('schedule:setPaused', paused),
  },
  // Agent 系统（定义 + 后台实例）
  agentSystem: {
    listDefinitions: (): Promise<{ success: boolean; definitions: AgentDefinition[] }> =>
      ipcRenderer.invoke('agent-system:definitions:list'),
    createDefinition: (draft: Omit<AgentDefinition, 'id'>): Promise<{ success: boolean; definition?: AgentDefinition; message?: string }> =>
      ipcRenderer.invoke('agent-system:definitions:create', draft),
    updateDefinition: (id: string, patch: Omit<AgentDefinition, 'id'>): Promise<{ success: boolean; definition?: AgentDefinition; message?: string }> =>
      ipcRenderer.invoke('agent-system:definitions:update', id, patch),
    deleteDefinition: (id: string): Promise<{ success: boolean }> =>
      ipcRenderer.invoke('agent-system:definitions:delete', id),
    listInstances: (): Promise<{ success: boolean; instances: AgentInstance[] }> =>
      ipcRenderer.invoke('agent-system:instances:list'),
    startInstance: (draft: { agentId?: string; task: string }): Promise<{ success: boolean; instance?: AgentInstance; message?: string }> =>
      ipcRenderer.invoke('agent-system:instances:start', draft),
    stopInstance: (id: string): Promise<{ success: boolean }> =>
      ipcRenderer.invoke('agent-system:instances:stop', id),
    /** 实例状态变更推送 */
    onInstancesUpdated: (callback: () => void): (() => void) => {
      const handler = (): void => callback()
      ipcRenderer.on('agent-instance:updated', handler)
      return () => ipcRenderer.removeListener('agent-instance:updated', handler)
    },
    /** 实例实时活动流推送 */
    onInstanceActivity: (callback: (data: { instanceId: string; activity: string }) => void): (() => void) => {
      const handler = (_event: unknown, data: { instanceId: string; activity: string }): void => callback(data)
      ipcRenderer.on('agent-instance:activity', handler)
      return () => ipcRenderer.removeListener('agent-instance:activity', handler)
    },
    /** 后台实例写回会话推送 — 渲染层需 reload，否则会被 _persist 全量覆盖 */
    onConversationUpdated: (callback: () => void): (() => void) => {
      const handler = (): void => callback()
      ipcRenderer.on('conversation:updated', handler)
      return () => ipcRenderer.removeListener('conversation:updated', handler)
    },
  },
  // 工作分摊（感知用户电脑操作 → 提议弹窗 → 用户确认 → 后台 Agent 执行）
  assist: {
    get: (): Promise<{ enabled: boolean; lastCheckAt: number }> =>
      ipcRenderer.invoke('assist:get'),
    set: (on: boolean): Promise<{ enabled: boolean }> =>
      ipcRenderer.invoke('assist:set', on),
    respond: (proposalId: string, accepted: boolean): Promise<{ success: boolean }> =>
      ipcRenderer.invoke('assist:respond', proposalId, accepted),
    /** 工作分摊提议推送 — 主进程感知到可分担的工作后征求用户同意 */
    onProposal: (callback: (proposal: { id: string; title: string; observation: string; proposedTask: string }) => void): (() => void) => {
      const handler = (_event: unknown, proposal: { id: string; title: string; observation: string; proposedTask: string }): void => callback(proposal)
      ipcRenderer.on('agent-assist:proposal', handler)
      return () => ipcRenderer.removeListener('agent-assist:proposal', handler)
    },
  },
}
