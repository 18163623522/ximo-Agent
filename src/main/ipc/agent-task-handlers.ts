/**
 * Agent 任务 IPC 处理器 — 定时任务、Agent 系统（定义 + 实例）、工作分摊
 */

import { ipcMain } from 'electron'
import type { ScheduleDraft } from '@shared/agent-schedule'
import type { AgentDefinition } from '@shared/agent-definition'

export function registerAgentTaskHandlers(): void {
  // ---------- Agent 定时任务 ----------
  ipcMain.handle('schedule:list', async () => {
    const { scheduleStore } = await import('@main/ScheduleStore')
    return { success: true, schedules: await scheduleStore.list() }
  })
  ipcMain.handle('schedule:create', async (_event, draft: ScheduleDraft) => {
    const { scheduleStore } = await import('@main/ScheduleStore')
    const schedule = await scheduleStore.create(draft)
    return schedule
      ? { success: true, schedule }
      : { success: false, message: '任务参数不完整：名称/指令/调度规则需填写完整' }
  })
  ipcMain.handle('schedule:update', async (_event, id: string, draft: ScheduleDraft) => {
    const { scheduleStore } = await import('@main/ScheduleStore')
    const schedule = await scheduleStore.update(id, draft)
    return schedule
      ? { success: true, schedule }
      : { success: false, message: '任务不存在或参数不完整' }
  })
  ipcMain.handle('schedule:delete', async (_event, id: string) => {
    const { scheduleStore } = await import('@main/ScheduleStore')
    await scheduleStore.remove(id)
    return { success: true }
  })
  ipcMain.handle('schedule:getPaused', async () => {
    const { scheduleStore } = await import('@main/ScheduleStore')
    return { paused: await scheduleStore.isPaused() }
  })
  ipcMain.handle('schedule:setPaused', async (_event, paused: boolean) => {
    const { scheduleStore } = await import('@main/ScheduleStore')
    await scheduleStore.setPaused(paused)
    return { success: true, paused }
  })

  // ---------- Agent 系统（定义 + 实例） ----------
  ipcMain.handle('agent-system:definitions:list', async () => {
    const { agentSystemStore } = await import('@main/AgentSystemStore')
    return { success: true, definitions: await agentSystemStore.listDefinitions() }
  })
  ipcMain.handle('agent-system:definitions:create', async (_event, draft: Omit<AgentDefinition, 'id'>) => {
    const { agentSystemStore } = await import('@main/AgentSystemStore')
    const definition = await agentSystemStore.createDefinition(draft)
    return definition
      ? { success: true, definition }
      : { success: false, message: 'Agent 名称不能为空' }
  })
  ipcMain.handle('agent-system:definitions:update', async (_event, id: string, patch: Omit<AgentDefinition, 'id'>) => {
    const { agentSystemStore } = await import('@main/AgentSystemStore')
    const definition = await agentSystemStore.updateDefinition(id, patch)
    return definition
      ? { success: true, definition }
      : { success: false, message: 'Agent 定义不存在或参数不完整' }
  })
  ipcMain.handle('agent-system:definitions:delete', async (_event, id: string) => {
    const { agentSystemStore } = await import('@main/AgentSystemStore')
    await agentSystemStore.deleteDefinition(id)
    return { success: true }
  })
  ipcMain.handle('agent-system:instances:list', async () => {
    const { agentSystemStore } = await import('@main/AgentSystemStore')
    return { success: true, instances: await agentSystemStore.listInstances() }
  })
  ipcMain.handle('agent-system:instances:start', async (_event, draft: { agentId?: string; task: string }) => {
    const { agentSystemStore } = await import('@main/AgentSystemStore')
    return agentSystemStore.startInstance(draft)
  })
  ipcMain.handle('agent-system:instances:stop', async (_event, id: string) => {
    const { agentSystemStore } = await import('@main/AgentSystemStore')
    return agentSystemStore.stopInstance(id)
  })

  // ---------- 工作分摊（AssistWatcher — 感知用户电脑 → 弹窗征求 → 后台分摊） ----------
  ipcMain.handle('assist:get', async () => {
    const { assistWatcher } = await import('@main/AssistWatcher')
    return { enabled: assistWatcher.isEnabled(), lastCheckAt: assistWatcher.getLastCheckAt() }
  })
  ipcMain.handle('assist:set', async (_event, on: boolean) => {
    const { assistWatcher } = await import('@main/AssistWatcher')
    return assistWatcher.setEnabled(!!on)
  })
  ipcMain.handle('assist:respond', async (_event, proposalId: string, accepted: boolean) => {
    const { assistWatcher } = await import('@main/AssistWatcher')
    assistWatcher.respondProposal(String(proposalId), !!accepted)
    return { success: true }
  })
}
