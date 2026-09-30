/**
 * preload API 分部 — 电脑操控 / 虚拟桌面 / WSL 工作区
 * 从 preload/index.ts 提取；由 index.ts 按原始键顺序展开合并
 */

import { ipcRenderer } from 'electron'
import type { VirtualDesktopInfo, DesktopWindowInfo } from '@shared/types'

export const computerApi = {
  // 操控电脑（pi-computer-use）启停
  computerUse: {
    start: (): Promise<{ success: boolean; running: boolean; error?: string }> =>
      ipcRenderer.invoke('computer-use:start'),
    stop: (): Promise<{ success: boolean; running: boolean }> =>
      ipcRenderer.invoke('computer-use:stop'),
    status: (): Promise<{ running: boolean }> =>
      ipcRenderer.invoke('computer-use:status')
  },
  // Agent 隔离工作区（虚拟桌面）— 逻辑分组管理
  virtualDesktop: {
    list: (): Promise<{ success: boolean; desktops?: VirtualDesktopInfo[]; error?: string }> =>
      ipcRenderer.invoke('virtual-desktop:list'),
    switch: (desktopId: string): Promise<{ success: boolean; error?: string }> =>
      ipcRenderer.invoke('virtual-desktop:switch', desktopId),
    create: (name?: string): Promise<{ success: boolean; desktops?: VirtualDesktopInfo[]; error?: string }> =>
      ipcRenderer.invoke('virtual-desktop:create', name),
    remove: (desktopId: string): Promise<{ success: boolean; desktops?: VirtualDesktopInfo[]; error?: string }> =>
      ipcRenderer.invoke('virtual-desktop:remove', desktopId),
    rename: (desktopId: string, name: string): Promise<{ success: boolean; desktops?: VirtualDesktopInfo[]; error?: string }> =>
      ipcRenderer.invoke('virtual-desktop:rename', desktopId, name),
    listWindows: (desktopId?: string): Promise<{ success: boolean; windows?: DesktopWindowInfo[]; error?: string }> =>
      ipcRenderer.invoke('virtual-desktop:listWindows', desktopId),
    moveWindow: (windowTitle: string, desktopId?: string): Promise<{ success: boolean; error?: string }> =>
      ipcRenderer.invoke('virtual-desktop:moveWindow', windowTitle, desktopId)
  },
  // Agent 隔离工作区（WSL Xvfb 桌面）
  workspace: {
    start: (): Promise<{ running: boolean; error: string | null; installedApps: string[]; setupStage: string; setupMessage: string; streamAvailable: boolean }> =>
      ipcRenderer.invoke('workspace:start'),
    stop: (): Promise<{ running: boolean; error: string | null }> =>
      ipcRenderer.invoke('workspace:stop'),
    state: (): Promise<{ running: boolean; error: string | null; lastScreenshot: string | null; setupStage: string; setupMessage: string; streamAvailable: boolean }> =>
      ipcRenderer.invoke('workspace:state'),
    screenshot: (): Promise<{ success: boolean; screenshot: string | null }> =>
      ipcRenderer.invoke('workspace:screenshot'),
    click: (x: number, y: number, button?: string): Promise<{ success: boolean }> =>
      ipcRenderer.invoke('workspace:click', x, y, button),
    key: (keys: string): Promise<{ success: boolean }> =>
      ipcRenderer.invoke('workspace:key', keys),
    type: (text: string): Promise<{ success: boolean }> =>
      ipcRenderer.invoke('workspace:type', text),
    exec: (command: string): Promise<{ success: boolean; output: string; error: string }> =>
      ipcRenderer.invoke('workspace:exec', command),
    launch: (app: string): Promise<{ success: boolean }> =>
      ipcRenderer.invoke('workspace:launch', app),
    /** 监听引导进度事件 */
    onProgress: (callback: (data: { stage: string; message: string }) => void): (() => void) => {
      const handler = (_event: unknown, data: { stage: string; message: string }): void => callback(data)
      ipcRenderer.on('workspace:progress', handler)
      return () => ipcRenderer.removeListener('workspace:progress', handler)
    },
  },
}
