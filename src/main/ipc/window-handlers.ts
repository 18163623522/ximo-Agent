/**
 * 系统相关 IPC 处理器 — 窗口控制（最小化 / 最大化切换 / 关闭 / 最大化状态查询）
 */

import { ipcMain, BrowserWindow } from 'electron'

export function registerWindowHandlers(): void {
  // ---------- 窗口控制 ----------
  ipcMain.handle('window:minimize', () => {
    BrowserWindow.getFocusedWindow()?.minimize()
  })
  ipcMain.handle('window:maximize', () => {
    const win = BrowserWindow.getFocusedWindow()
    if (win) {
      if (win.isMaximized()) {
        win.unmaximize()
      } else {
        win.maximize()
      }
    }
  })
  ipcMain.handle('window:close', () => {
    BrowserWindow.getFocusedWindow()?.close()
  })
  ipcMain.handle('window:isMaximized', () => {
    return BrowserWindow.getFocusedWindow()?.isMaximized() ?? false
  })
}
