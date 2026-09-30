import type { StateCreator } from 'zustand'
import type { VirtualDesktopInfo, DesktopWindowInfo } from '@shared/types'
import type { StoreState } from '@renderer/store/types'

export type DesktopSlice = Pick<StoreState,
  | 'desktopOpen'
  | 'desktopList'
  | 'desktopWindows'
  | 'desktopActiveId'
  | 'desktopLoading'
  | 'desktopError'
  | 'toggleDesktop'
  | 'refreshDesktops'
  | 'switchDesktop'
  | 'createDesktop'
  | 'removeDesktop'
  | 'renameDesktop'
  | 'refreshDesktopWindows'
  | 'moveWindowToDesktop'
>

export const createDesktopSlice: StateCreator<StoreState, [], [], DesktopSlice> = (set, get) => ({
  desktopOpen: false,
  desktopList: [] as VirtualDesktopInfo[],
  desktopWindows: [] as DesktopWindowInfo[],
  desktopActiveId: '',
  desktopLoading: false,
  desktopError: null,

  toggleDesktop: () => {
    set((s) => {
      if (s.desktopOpen) {
        return { desktopOpen: false, desktopList: [], desktopWindows: [], desktopActiveId: '', desktopError: null }
      }
      // 开启时自动拉取桌面列表
      void get().refreshDesktops()
      return { desktopOpen: true }
    })
  },

  refreshDesktops: async () => {
    set({ desktopLoading: true, desktopError: null })
    const result = await window.api.virtualDesktop.list()
    if (result.success && result.desktops) {
      const active = result.desktops.find((d) => d.isActive)
      set({ desktopList: result.desktops, desktopActiveId: active?.id ?? '', desktopLoading: false })
      // 拉取当前桌面的窗口列表
      void get().refreshDesktopWindows(active?.id)
    } else {
      set({ desktopLoading: false, desktopError: result.error ?? '获取桌面列表失败' })
    }
  },

  switchDesktop: async (desktopId: string) => {
    set({ desktopLoading: true, desktopError: null })
    const result = await window.api.virtualDesktop.switch(desktopId)
    if (result.success) {
      set({ desktopActiveId: desktopId })
      await get().refreshDesktops()
    } else {
      set({ desktopLoading: false, desktopError: result.error ?? '切换桌面失败' })
    }
  },

  createDesktop: async (name?: string) => {
    set({ desktopLoading: true, desktopError: null })
    const result = await window.api.virtualDesktop.create(name)
    if (result.success) {
      await get().refreshDesktops()
    } else {
      set({ desktopLoading: false, desktopError: result.error ?? '创建工作区失败' })
    }
  },

  removeDesktop: async (desktopId: string) => {
    set({ desktopLoading: true, desktopError: null })
    const result = await window.api.virtualDesktop.remove(desktopId)
    if (result.success) {
      await get().refreshDesktops()
    } else {
      set({ desktopLoading: false, desktopError: result.error ?? '删除工作区失败' })
    }
  },

  renameDesktop: async (desktopId: string, name: string) => {
    set({ desktopLoading: true, desktopError: null })
    const result = await window.api.virtualDesktop.rename(desktopId, name)
    if (result.success) {
      await get().refreshDesktops()
    } else {
      set({ desktopLoading: false, desktopError: result.error ?? '重命名工作区失败' })
    }
  },

  refreshDesktopWindows: async (desktopId?: string) => {
    const result = await window.api.virtualDesktop.listWindows(desktopId)
    if (result.success && result.windows) {
      set({ desktopWindows: result.windows })
    } else {
      set({ desktopWindows: [], desktopError: result.error ?? '获取窗口列表失败' })
    }
  },

  moveWindowToDesktop: async (windowTitle: string, desktopId?: string) => {
    set({ desktopLoading: true, desktopError: null })
    const result = await window.api.virtualDesktop.moveWindow(windowTitle, desktopId)
    if (result.success) {
      // 移动后刷新窗口列表
      await get().refreshDesktopWindows(get().desktopActiveId || undefined)
      set({ desktopLoading: false })
    } else {
      set({ desktopLoading: false, desktopError: result.error ?? '移动窗口失败' })
    }
  },
})
