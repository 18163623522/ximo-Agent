/**
 * preload API 分部 — ximo-OS 主机（cockpit-link 驾驶舱客户端）
 * 从 preload/index.ts 提取；由 index.ts 按原始键顺序展开合并
 *
 * 通道命名遵循 `域:动作` 规范（host:*）；推送事件与 main 侧 host-handlers 的
 * 字面量 send 通道一一对应（IPC 契约测试对账）。
 */

import { ipcRenderer } from 'electron'
import type { HostTaskRecord, HostHealth, HostStatusInfo, HostMsg, DesktopAction, DesktopScreenSize, HostScreenSnapshot } from '@shared/types'

export const hostApi = {
  host: {
    /** 连接主机 — 不传则用设置中的 hostUrl/hostToken */
    connect: (url?: string, token?: string): Promise<{ success: boolean }> =>
      ipcRenderer.invoke('host:connect', url, token),
    disconnect: (): Promise<{ success: boolean }> => ipcRenderer.invoke('host:disconnect'),
    status: (): Promise<HostStatusInfo> => ipcRenderer.invoke('host:status'),
    /** 健康探测 — 设置页「测试连接」；不传参用设置中的配置 */
    health: (url?: string, token?: string): Promise<HostHealth> =>
      ipcRenderer.invoke('host:health', url, token),
    /** 派任务 → { ok, id? , error? }（主机受理即返回，结果经 onEvent 流式到达） */
    dispatch: (task: string, mode?: string): Promise<{ ok: boolean; id?: string; error?: string }> =>
      ipcRenderer.invoke('host:dispatch', task, mode),
    cancel: (id: string): Promise<{ success: boolean }> => ipcRenderer.invoke('host:cancel', id),
    /** 回应主机侧审批请求（fail-closed：主机 120s 无响应视为拒绝） */
    approvalRespond: (reqId: string, allow: boolean): Promise<{ success: boolean }> =>
      ipcRenderer.invoke('host:approvalRespond', reqId, allow),
    /** 任务列表 — 已连接时走 REST 合并历史，否则返回本地实时视图 */
    listTasks: (): Promise<HostTaskRecord[]> => ipcRenderer.invoke('host:tasks'),

    /** desktop-bus 调用 — 窗口/应用/键鼠/屏幕几何（阶段 2 渲染端交互通道） */
    desktop: (action: DesktopAction, params?: Record<string, unknown>): Promise<{ ok: boolean; data?: unknown; error?: string }> =>
      ipcRenderer.invoke('host:desktop', action, params),
    /** 单帧截图 — 画面流不可用时的兜底 */
    screenSnapshot: (): Promise<HostScreenSnapshot> => ipcRenderer.invoke('host:screenSnapshot'),
    /** 屏幕几何（类型别名，数据经 desktop('screen.size') 取得） */
    screenSize: (): Promise<DesktopScreenSize | null> =>
      ipcRenderer.invoke('host:desktop', 'screen.size').then((r: { ok: boolean; data?: unknown }) =>
        r.ok ? (r.data as DesktopScreenSize) : null),

    /** 连接状态推送 */
    onStatus: (callback: (s: HostStatusInfo) => void): (() => void) => {
      const handler = (_e: unknown, s: HostStatusInfo): void => callback(s)
      ipcRenderer.on('host:status', handler)
      return () => ipcRenderer.removeListener('host:status', handler)
    },
    /** 任务表快照推送 — 主机每有增量即重推全量 */
    onTasks: (callback: (tasks: HostTaskRecord[]) => void): (() => void) => {
      const handler = (_e: unknown, tasks: HostTaskRecord[]): void => callback(tasks)
      ipcRenderer.on('host:tasks', handler)
      return () => ipcRenderer.removeListener('host:tasks', handler)
    },
    /** 主机原始帧推送 — 用于转录流式渲染与审批弹窗 */
    onEvent: (callback: (m: HostMsg) => void): (() => void) => {
      const handler = (_e: unknown, m: HostMsg): void => callback(m)
      ipcRenderer.on('host:event', handler)
      return () => ipcRenderer.removeListener('host:event', handler)
    },
  },
}
