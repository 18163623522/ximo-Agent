/**
 * ximo-OS 主机 IPC 处理器 — 驾驶舱侧 cockpit-link 客户端接线
 *
 * 主进程持有一个 HostClient 单例，把主机的连接状态 / 任务快照 / 原始事件广播给
 * 所有渲染窗口；渲染层通过 host:* 通道发起连接与派任务。
 *
 * 令牌来源：settings.hostToken（safeStorage 加密落盘，见 secure-storage.ts）。
 * 未显式传参时回退到已加载设置中的主机配置。
 */
import { BrowserWindow, ipcMain } from 'electron'
import { HostClient } from '@main/host/HostClient'
import type { HostTaskRecord, HostStatusInfo, HostMsg } from '@shared/types'

/** 向所有渲染窗口推送 — 字面量通道名，与 preload 订阅一一对应（IPC 契约测试对账） */
function pushStatus(s: HostStatusInfo): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send('host:status', s)
  }
}
function pushTasks(t: HostTaskRecord[]): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send('host:tasks', t)
  }
}
function pushEvent(m: HostMsg): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send('host:event', m)
  }
}

/** HostClient 单例 — 事件统一广播到所有窗口 */
export const hostClient = new HostClient({
  status: pushStatus,
  tasks: pushTasks,
  event: pushEvent,
})

/** 读取主机配置 — 显式传参优先，否则回退到设置 */
async function resolveConfig(url?: string, token?: string): Promise<{ url: string; token: string }> {
  if (url && token) return { url, token }
  const { loadSettings } = await import('@main/store')
  const s = await loadSettings()
  return { url: url || s.hostUrl || '', token: token || s.hostToken || '' }
}

export function registerHostHandlers(): void {
  ipcMain.handle('host:connect', async (_event, url?: string, token?: string) => {
    const cfg = await resolveConfig(url, token)
    hostClient.connect(cfg.url, cfg.token)
    return { success: true }
  })

  ipcMain.handle('host:disconnect', () => {
    hostClient.disconnect()
    return { success: true }
  })

  ipcMain.handle('host:status', () => hostClient.getStatus())

  ipcMain.handle('host:health', async (_event, url?: string, token?: string) => {
    // 支持「未连接先测连通」——用传入配置做一次性探测，不改动现有连接
    const cfg = await resolveConfig(url, token)
    const probe = new HostClient({ status: () => {}, tasks: () => {}, event: () => {} })
    probe.connect(cfg.url, cfg.token)
    const result = await probe.health()
    probe.disconnect()
    return result
  })

  ipcMain.handle('host:dispatch', async (_event, task: string, mode?: string) => {
    return hostClient.dispatch(task, mode)
  })

  ipcMain.handle('host:cancel', (_event, id: string) => {
    hostClient.cancel(id)
    return { success: true }
  })

  ipcMain.handle('host:approvalRespond', (_event, reqId: string, allow: boolean) => {
    hostClient.respondApproval(reqId, !!allow)
    return { success: true }
  })

  ipcMain.handle('host:tasks', async (): Promise<HostTaskRecord[]> => {
    if (!hostClient.isConnected()) return hostClient.getTasks()
    return hostClient.listTasks()
  })
}
