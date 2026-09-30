import { useEffect, useState, useCallback } from 'react'
import { Monitor, Plus, Trash2, RefreshCw, ArrowRight, Loader2, AlertCircle, AppWindow, Pencil, Check, X } from 'lucide-react'
import { useStore } from '@renderer/store/useStore'
import type { VirtualDesktopInfo, DesktopWindowInfo } from '@shared/types'

/**
 * VirtualDesktopPanel — Agent 隔离工作区管理面板（右侧栏）
 *
 * 与 EmbeddedBrowserPanel 同级，开启后显示在右侧栏。
 * 显示工作区列表、当前工作区的窗口列表，支持切换/创建/删除/重命名工作区。
 * 数据全部来自应用层逻辑分组（通过 IPC 调用主进程 Win32 ShowWindow 后端）。
 */
export function VirtualDesktopPanel(): React.ReactElement {
  const desktopList = useStore((s) => s.desktopList)
  const desktopWindows = useStore((s) => s.desktopWindows)
  const desktopActiveId = useStore((s) => s.desktopActiveId)
  const desktopLoading = useStore((s) => s.desktopLoading)
  const desktopError = useStore((s) => s.desktopError)
  const toggleDesktop = useStore((s) => s.toggleDesktop)
  const refreshDesktops = useStore((s) => s.refreshDesktops)
  const switchDesktop = useStore((s) => s.switchDesktop)
  const createDesktop = useStore((s) => s.createDesktop)
  const removeDesktop = useStore((s) => s.removeDesktop)
  const renameDesktop = useStore((s) => s.renameDesktop)
  const refreshDesktopWindows = useStore((s) => s.refreshDesktopWindows)

  // 选中的桌面（用于查看非活跃桌面的窗口）
  const [selectedDesktopId, setSelectedDesktopId] = useState<string>('')
  // 正在重命名的桌面 ID
  const [renamingId, setRenamingId] = useState<string>('')
  // 重命名输入值
  const [renameValue, setRenameValue] = useState('')

  // 当前选中桌面 ID — 缺省跟随活跃桌面
  const currentSelected = selectedDesktopId || desktopActiveId

  // 选中桌面变化时刷新窗口列表
  useEffect(() => {
    if (currentSelected) {
      void refreshDesktopWindows(currentSelected)
    }
  }, [currentSelected, refreshDesktopWindows])

  // 切换桌面后自动同步选中
  useEffect(() => {
    if (desktopActiveId && !selectedDesktopId) {
      void refreshDesktopWindows(desktopActiveId)
    }
  }, [desktopActiveId, selectedDesktopId, refreshDesktopWindows])

  const handleSwitch = useCallback((desktop: VirtualDesktopInfo): void => {
    if (desktop.isActive) return
    void switchDesktop(desktop.id)
    setSelectedDesktopId('')
  }, [switchDesktop])

  const handleCreate = useCallback((): void => {
    void createDesktop()
  }, [createDesktop])

  const handleRemove = useCallback((e: React.MouseEvent, desktopId: string): void => {
    e.stopPropagation()
    void removeDesktop(desktopId)
  }, [removeDesktop])

  const handleRefresh = useCallback((): void => {
    void refreshDesktops()
  }, [refreshDesktops])

  const handleStartRename = useCallback((desktop: VirtualDesktopInfo): void => {
    setRenamingId(desktop.id)
    setRenameValue(desktop.name)
  }, [])

  const handleConfirmRename = useCallback((): void => {
    if (renamingId && renameValue.trim()) {
      void renameDesktop(renamingId, renameValue.trim())
    }
    setRenamingId('')
    setRenameValue('')
  }, [renamingId, renameValue, renameDesktop])

  const handleCancelRename = useCallback((): void => {
    setRenamingId('')
    setRenameValue('')
  }, [])

  const activeDesktop = desktopList.find((d) => d.isActive)
  const selectedDesktop = desktopList.find((d) => d.id === currentSelected)

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* 顶栏 */}
      <div className="flex items-center gap-1 border-b border-border-subtle px-2 py-1.5 shrink-0">
        <Monitor size={13} className="text-accent shrink-0" />
        <span className="text-xs font-medium text-text-secondary flex-1">工作区</span>
        <button
          onClick={handleRefresh}
          disabled={desktopLoading}
          className="icon-btn rounded-control p-1 disabled:opacity-40"
          title="刷新"
        >
          <RefreshCw size={11} className={desktopLoading ? 'animate-spin' : ''} />
        </button>
        <button
          onClick={handleCreate}
          disabled={desktopLoading}
          className="icon-btn rounded-control p-1 text-accent disabled:opacity-40"
          title="新建工作区"
        >
          <Plus size={11} />
        </button>
        <button
          onClick={toggleDesktop}
          className="icon-btn rounded-control p-1"
          title="关闭"
        >
          <span className="text-caption text-text-muted">×</span>
        </button>
      </div>

      {/* 错误提示 */}
      {desktopError && (
        <div className="flex items-center gap-2 px-3 py-2 bg-state-error/10 border-b border-state-error/20">
          <AlertCircle size={12} className="text-state-error shrink-0" />
          <span className="text-caption text-state-error flex-1 truncate">{desktopError}</span>
        </div>
      )}

      {/* 桌面列表 */}
      <div className="shrink-0 border-b border-border-subtle">
        <div className="px-2 py-1.5">
          <span className="text-caption text-text-muted">工作区列表（{desktopList.length}）</span>
        </div>
        <div className="max-h-[200px] overflow-y-auto px-1.5 pb-1.5 space-y-0.5">
          {desktopList.length === 0 && !desktopLoading && (
            <p className="px-2 py-2 text-caption text-text-muted text-center">暂无工作区信息</p>
          )}
          {desktopList.map((desktop, i) => (
            <DesktopItem
              key={desktop.id}
              desktop={desktop}
              index={i}
              isSelected={desktop.id === currentSelected}
              isRenaming={renamingId === desktop.id}
              renameValue={renameValue}
              onRenameValueChange={setRenameValue}
              onSelect={() => setSelectedDesktopId(desktop.id)}
              onSwitch={() => handleSwitch(desktop)}
              onRemove={(e) => handleRemove(e, desktop.id)}
              onStartRename={() => handleStartRename(desktop)}
              onConfirmRename={handleConfirmRename}
              onCancelRename={handleCancelRename}
            />
          ))}
        </div>
      </div>

      {/* 当前桌面的窗口列表 */}
      <div className="flex min-h-0 flex-1 flex-col">
        <div className="flex items-center gap-1.5 px-2 py-1.5 shrink-0">
          <AppWindow size={12} className="text-text-muted shrink-0" />
          <span className="text-caption text-text-muted flex-1">
            {selectedDesktop?.name || activeDesktop?.name || '工作区'} 的窗口
          </span>
          <span className="text-caption text-text-quaternary">{desktopWindows.length}</span>
        </div>
        <div className="flex-1 overflow-y-auto px-1.5 pb-2 space-y-0.5">
          {desktopWindows.length === 0 ? (
            <p className="px-2 py-3 text-caption text-text-muted text-center">
              {desktopLoading ? '加载中...' : '该工作区上没有可见窗口'}
            </p>
          ) : (
            desktopWindows.map((w, i) => (
              <WindowItem key={`${w.hwnd}-${i}`} window={w} />
            ))
          )}
        </div>
      </div>
    </div>
  )
}

// ---- 子组件 ----

function DesktopItem({
  desktop, index, isSelected, isRenaming, renameValue,
  onRenameValueChange, onSelect, onSwitch, onRemove,
  onStartRename, onConfirmRename, onCancelRename,
}: {
  desktop: VirtualDesktopInfo
  index: number
  isSelected: boolean
  isRenaming: boolean
  renameValue: string
  onRenameValueChange: (v: string) => void
  onSelect: () => void
  onSwitch: () => void
  onRemove: (e: React.MouseEvent) => void
  onStartRename: () => void
  onConfirmRename: () => void
  onCancelRename: () => void
}): React.ReactElement {
  const name = desktop.name || `工作区 ${index + 1}`
  return (
    <div
      onClick={onSelect}
      className={`group flex items-center gap-2 rounded-card px-2 py-1.5 cursor-pointer transition-colors ${
        isSelected
          ? 'bg-accent/15 text-accent'
          : desktop.isActive
            ? 'bg-bg-hover text-text-primary'
            : 'text-text-secondary hover:bg-bg-hover'
      }`}
    >
      <span className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-control text-caption ${
        desktop.isActive ? 'bg-accent/20 text-accent' : 'bg-bg-hover text-text-muted'
      }`}>
        {desktop.isActive ? <Loader2 size={10} className="opacity-0" /> : index + 1}
      </span>
      {isRenaming ? (
        <div className="flex min-w-0 flex-1 items-center gap-1">
          <input
            autoFocus
            value={renameValue}
            onChange={(e) => onRenameValueChange(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') onConfirmRename()
              if (e.key === 'Escape') onCancelRename()
            }}
            onClick={(e) => e.stopPropagation()}
            className="min-w-0 flex-1 bg-bg-input border border-accent/40 rounded-control px-1.5 py-0.5 text-xs text-text-primary outline-none"
          />
          <button
            onClick={(e) => { e.stopPropagation(); onConfirmRename() }}
            className="icon-btn rounded-control p-0.5 text-accent hover:bg-accent/10"
            title="确认"
          >
            <Check size={11} />
          </button>
          <button
            onClick={(e) => { e.stopPropagation(); onCancelRename() }}
            className="icon-btn rounded-control p-0.5 text-text-muted hover:bg-bg-hover"
            title="取消"
          >
            <X size={11} />
          </button>
        </div>
      ) : (
        <>
          <span className="flex-1 text-xs truncate">{name}</span>
          <span className="text-caption text-text-quaternary shrink-0">{desktop.windowCount} 窗口</span>
          {desktop.isActive && (
            <span className="text-caption text-accent shrink-0">活跃</span>
          )}
          <button
            onClick={(e) => { e.stopPropagation(); onStartRename() }}
            className="opacity-0 group-hover:opacity-100 transition-opacity icon-btn rounded-control p-0.5 text-text-muted hover:text-accent"
            title="重命名"
          >
            <Pencil size={10} />
          </button>
          {!desktop.isActive && (
            <button
              onClick={(e) => { e.stopPropagation(); onSwitch() }}
              className="opacity-0 group-hover:opacity-100 transition-opacity icon-btn rounded-control p-0.5 text-accent hover:bg-accent/10"
              title="切换到此工作区"
            >
              <ArrowRight size={11} />
            </button>
          )}
          <button
            onClick={onRemove}
            className="opacity-0 group-hover:opacity-100 transition-opacity icon-btn rounded-control p-0.5 text-text-muted hover:text-state-error"
            title="删除此工作区"
          >
            <Trash2 size={11} />
          </button>
        </>
      )}
    </div>
  )
}

function WindowItem({ window: win }: { window: DesktopWindowInfo }): React.ReactElement {
  return (
    <div className="group flex items-center gap-2 rounded-card px-2 py-1.5 bg-bg-hover-soft hover:bg-bg-hover transition-colors">
      <span className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-control ${
        win.isFocused ? 'bg-accent/20 text-accent' : 'bg-bg-hover text-text-muted'
      }`}>
        <AppWindow size={10} />
      </span>
      <div className="min-w-0 flex-1">
        <p className={`text-xs truncate ${win.isFocused ? 'text-accent font-medium' : 'text-text-secondary'}`}>
          {win.title || '(无标题)'}
        </p>
        {win.appName && (
          <p className="text-caption text-text-muted truncate">{win.appName}</p>
        )}
      </div>
      {win.isFocused && <span className="text-caption text-accent shrink-0">🔥</span>}
    </div>
  )
}
