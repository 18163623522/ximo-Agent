/**
 * preload API 分部 — 终端 / 文件系统 / 检查点 / pi-helper
 * 从 preload/index.ts 提取；由 index.ts 按原始键顺序展开合并
 */

import { ipcRenderer } from 'electron'
import type { FileTreeNode } from '@shared/types'

export const filesApi = {
  terminal: {
    execute: (command: string, cwd?: string): Promise<{ stdout: string; stderr: string; exitCode: number }> =>
      ipcRenderer.invoke('terminal:execute', command, cwd)
  },
  fs: {
    listDir: (dirPath: string, maxDepth?: number): Promise<FileTreeNode[]> =>
      ipcRenderer.invoke('fs:listDir', dirPath, maxDepth),
    readFileContent: (filePath: string, maxLines?: number): Promise<{ success: boolean; content?: string; totalLines?: number; filePath?: string; error?: string }> =>
      ipcRenderer.invoke('fs:readFileContent', filePath, maxLines),
    writeFile: (filePath: string, content: string): Promise<{ success: boolean; filePath?: string; error?: string }> =>
      ipcRenderer.invoke('fs:writeFile', filePath, content),
    deleteFile: (filePath: string): Promise<{ success: boolean; filePath?: string; error?: string }> =>
      ipcRenderer.invoke('fs:deleteFile', filePath),
    renameFile: (oldPath: string, newPath: string): Promise<{ success: boolean; oldPath?: string; newPath?: string; error?: string }> =>
      ipcRenderer.invoke('fs:renameFile', oldPath, newPath),
    copyFile: (srcPath: string, destPath: string): Promise<{ success: boolean; srcPath?: string; destPath?: string; error?: string }> =>
      ipcRenderer.invoke('fs:copyFile', srcPath, destPath),
    createDir: (dirPath: string): Promise<{ success: boolean; dirPath?: string; error?: string }> =>
      ipcRenderer.invoke('fs:createDir', dirPath),
    revertFile: (snapshotPath: string, targetPath: string): Promise<{ success: boolean; message?: string; error?: string }> =>
      ipcRenderer.invoke('fs:revertFile', snapshotPath, targetPath),
    listSnapshots: (targetFilePath?: string): Promise<{ success: boolean; snapshots: Array<{ name: string; path: string; size: number; mtime: number }> }> =>
      ipcRenderer.invoke('fs:listSnapshots', targetFilePath)
  },
  checkpoint: {
    list: (sessionId: string): Promise<{ success: boolean; checkpoints: Array<{ turn: number; time: number; prompt: string; paths: string[] }> }> =>
      ipcRenderer.invoke('checkpoint:list', sessionId),
    restore: (sessionId: string, fromTurn: number): Promise<{ success: boolean; written: string[]; deleted: string[]; errors: string[] }> =>
      ipcRenderer.invoke('checkpoint:restore', sessionId, fromTurn),
    bounds: (sessionId: string): Promise<{ success: boolean; bounds: Record<number, number> }> =>
      ipcRenderer.invoke('checkpoint:bounds', sessionId),
    clear: (sessionId: string): Promise<{ success: boolean }> =>
      ipcRenderer.invoke('checkpoint:clear', sessionId)
  },
  piHelper: {
    status: (): Promise<{ ready: boolean; error?: string; path: string }> =>
      ipcRenderer.invoke('pi-helper:status')
  },
}
