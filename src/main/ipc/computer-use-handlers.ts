/**
 * 系统相关 IPC 处理器 — 操控电脑（pi-computer-use）Helper 状态 / 启停与终端命令执行
 */

import { ipcMain } from 'electron'

export function registerComputerUseHandlers(): void {
  // ---------- pi-computer-use Helper 状态查询 ----------
  ipcMain.handle('pi-helper:status', async () => {
    const { piBridge, WINDOWS_HELPER_PATH } = await import('@main/tools/ComputerUse/PiBridge')
    try {
      await piBridge.ensureReady()
      return { ready: true, path: WINDOWS_HELPER_PATH }
    } catch (e) {
      return { ready: false, error: (e as Error).message, path: WINDOWS_HELPER_PATH }
    }
  })

  // ---------- 终端命令执行 ----------
  ipcMain.handle('terminal:execute', async (_event, command: string, cwd?: string) => {
    const { spawn } = await import('child_process')
    const isWin = process.platform === 'win32'
    const shell = isWin ? 'powershell.exe' : '/bin/sh'
    const shellArgs = isWin ? ['-NoProfile', '-Command', command] : ['-c', command]
    return new Promise((resolve) => {
      const child = spawn(shell, shellArgs, {
        cwd: cwd || undefined,
        windowsHide: true,
        timeout: 30000
      })
      let stdout = ''
      let stderr = ''
      child.stdout?.on('data', (data: Buffer) => { stdout += data.toString('utf-8') })
      child.stderr?.on('data', (data: Buffer) => { stderr += data.toString('utf-8') })
      child.on('close', (exitCode: number | null) => {
        const code = exitCode ?? 0
        resolve({
          stdout: stdout || '',
          stderr: stderr || (code !== 0 ? `Command exited with code ${code}` : ''),
          exitCode: code
        })
      })
      child.on('error', (err: Error) => {
        resolve({
          stdout: stdout || '',
          stderr: stderr || err.message,
          exitCode: 1
        })
      })
    })
  })

  // ---------- 操控电脑（pi-computer-use）启停 ----------
  ipcMain.handle('computer-use:start', async () => {
    try {
      const { piBridge } = await import('@main/tools/ComputerUse/PiBridge')
      await piBridge.ensureReady()
      return { success: true, running: true }
    } catch (e) {
      return { success: false, running: false, error: (e as Error).message }
    }
  })
  ipcMain.handle('computer-use:stop', async () => {
    try {
      const { piBridge } = await import('@main/tools/ComputerUse/PiBridge')
      piBridge.dispose()
      return { success: true, running: false }
    } catch {
      return { success: true, running: false }
    }
  })
  ipcMain.handle('computer-use:status', async () => {
    const { piBridge } = await import('@main/tools/ComputerUse/PiBridge')
    return { running: piBridge.ready }
  })
}
