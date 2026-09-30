/**
 * VirtualDesktopTypes — 虚拟桌面持久化状态类型
 *
 * 从 VirtualDesktopManager.ts 拆出的持久化数据结构：
 * - DesktopRecord：单个虚拟桌面（id / 名称 / 分配的窗口句柄列表）
 * - WorkspaceState：工作区整体状态（桌面列表 + 当前活跃桌面 id）
 */

// ---------------------------------------------------------------------------
// 持久化状态结构
// ---------------------------------------------------------------------------

export interface DesktopRecord {
  id: string
  name: string
  hwnds: number[]  // 分配到此桌面的窗口句柄列表
}

export interface WorkspaceState {
  desktops: DesktopRecord[]
  activeDesktopId: string
}
