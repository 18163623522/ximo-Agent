// ====== Agent 隔离工作区（虚拟桌面）类型 ======

/** 工作区信息 */
export interface VirtualDesktopInfo {
  /** 工作区 ID（应用层生成的唯一标识） */
  id: string
  /** 工作区名称 */
  name: string
  /** 是否为当前活跃工作区 */
  isActive: boolean
  /** 工作区内的顶层窗口数量 */
  windowCount: number
}

/** 工作区上的窗口信息 */
export interface DesktopWindowInfo {
  /** 窗口句柄（HWND）的字符串表示 */
  hwnd: string
  /** 窗口标题 */
  title: string
  /** 所属进程/应用名称 */
  appName: string
  /** 窗口所属的工作区 ID */
  desktopId: string
  /** 是否为当前活跃窗口 */
  isFocused: boolean
  /** 窗口矩形坐标 { x, y, width, height } */
  bounds: { x: number; y: number; width: number; height: number }
}

/** 工作区操作结果 */
export interface DesktopActionResult {
  success: boolean
  error?: string
  /** 操作后的工作区列表（list/create/remove/rename 返回） */
  desktops?: VirtualDesktopInfo[]
  /** 操作后的窗口列表（仅 listWindows 返回） */
  windows?: DesktopWindowInfo[]
}
