/**
 * Agent 隔离工作区 IPC 处理器 — 虚拟桌面（VirtualDesktop）与 WSL 工作区
 */

import { ipcMain } from 'electron'

export function registerWorkspaceHandlers(): void {
  // ---------- Agent 隔离工作区（虚拟桌面）----------
  ipcMain.handle('virtual-desktop:list', async () => {
    const { virtualDesktopManager } = await import('@main/tools/VirtualDesktop')
    return virtualDesktopManager.list()
  })
  ipcMain.handle('virtual-desktop:switch', async (_event, desktopId: string) => {
    const { virtualDesktopManager } = await import('@main/tools/VirtualDesktop')
    return virtualDesktopManager.switch(desktopId)
  })
  ipcMain.handle('virtual-desktop:create', async (_event, name?: string) => {
    const { virtualDesktopManager } = await import('@main/tools/VirtualDesktop')
    return virtualDesktopManager.create(name)
  })
  ipcMain.handle('virtual-desktop:remove', async (_event, desktopId: string) => {
    const { virtualDesktopManager } = await import('@main/tools/VirtualDesktop')
    return virtualDesktopManager.remove(desktopId)
  })
  ipcMain.handle('virtual-desktop:rename', async (_event, desktopId: string, name: string) => {
    const { virtualDesktopManager } = await import('@main/tools/VirtualDesktop')
    return virtualDesktopManager.rename(desktopId, name)
  })
  ipcMain.handle('virtual-desktop:listWindows', async (_event, desktopId?: string) => {
    const { virtualDesktopManager } = await import('@main/tools/VirtualDesktop')
    return virtualDesktopManager.listWindows(desktopId)
  })
  ipcMain.handle('virtual-desktop:moveWindow', async (_event, windowTitle: string, desktopId?: string) => {
    const { virtualDesktopManager } = await import('@main/tools/VirtualDesktop')
    return virtualDesktopManager.moveWindow(windowTitle, desktopId)
  })

  // ---------- Agent 隔离工作区（WSL）----------
  ipcMain.handle('workspace:start', async (event) => {
    const { agentWorkspaceManager } = await import('@main/tools/AgentWorkspace')
    // 注册进度回调 — 实时推送引导阶段到渲染进程
    const sender = event.sender
    agentWorkspaceManager.onProgress((stage, message) => {
      if (!sender.isDestroyed()) {
        sender.send('workspace:progress', { stage, message })
      }
    })
    return agentWorkspaceManager.start()
  })
  ipcMain.handle('workspace:stop', async () => {
    const { agentWorkspaceManager } = await import('@main/tools/AgentWorkspace')
    return agentWorkspaceManager.stop()
  })
  ipcMain.handle('workspace:state', async () => {
    const { agentWorkspaceManager } = await import('@main/tools/AgentWorkspace')
    return agentWorkspaceManager.getState()
  })
  ipcMain.handle('workspace:screenshot', async () => {
    const { agentWorkspaceManager } = await import('@main/tools/AgentWorkspace')
    const screenshot = await agentWorkspaceManager.screenshot()
    return { success: !!screenshot, screenshot }
  })
  ipcMain.handle('workspace:click', async (_event, x: number, y: number, button?: string) => {
    const { agentWorkspaceManager } = await import('@main/tools/AgentWorkspace')
    const success = await agentWorkspaceManager.click(x, y, (button as 'left' | 'right' | 'middle') || 'left')
    return { success }
  })
  ipcMain.handle('workspace:key', async (_event, keys: string) => {
    const { agentWorkspaceManager } = await import('@main/tools/AgentWorkspace')
    const success = await agentWorkspaceManager.keyPress(keys)
    return { success }
  })
  ipcMain.handle('workspace:type', async (_event, text: string) => {
    const { agentWorkspaceManager } = await import('@main/tools/AgentWorkspace')
    const success = await agentWorkspaceManager.typeText(text)
    return { success }
  })
  ipcMain.handle('workspace:exec', async (_event, command: string) => {
    const { agentWorkspaceManager } = await import('@main/tools/AgentWorkspace')
    return agentWorkspaceManager.exec(command)
  })
  ipcMain.handle('workspace:launch', async (_event, app: string) => {
    const { agentWorkspaceManager } = await import('@main/tools/AgentWorkspace')
    const result = await agentWorkspaceManager.launchApp(app)
    return { success: result.success, alive: result.alive, error: result.error }
  })
}
