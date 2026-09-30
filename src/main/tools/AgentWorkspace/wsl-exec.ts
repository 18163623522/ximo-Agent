/**
 * wsl-exec — 无状态 WSL 执行原语
 *
 * wsl.exe 命令执行的底层封装与共享常量：execWslRaw（原始 shell）、
 * execWslDisplay（附加 DISPLAY 环境与会话 env source）。
 * 本模块不持有任何可变状态，可被引导层/桌面操作层/管理器安全复用。
 */

import { execFile } from 'child_process'
import { promisify } from 'util'

const execFileAsync = promisify(execFile)

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

// 使用 Debian — 比 Ubuntu 轻 1.5GB，无 snap/广告，apt 兼容
export const WSL_DISTRIBUTION = 'Debian'
export const DISPLAY = ':99'
export const WSL_TIMEOUT = 30_000

// ffmpeg MJPEG 实时画面流 — WSL 内监听，主进程经 wslcam:// 协议代理给渲染层 <img>
export const WSL_STREAM_PORT = 8090
export const WSL_STREAM_URL = `http://127.0.0.1:${WSL_STREAM_PORT}/stream`

/** 执行 WSL 命令（原始 shell），返回 stdout */
export async function execWslRaw(command: string, timeoutMs: number = WSL_TIMEOUT): Promise<string> {
  const args = ['-d', WSL_DISTRIBUTION, '--', 'bash', '-c', command]
  try {
    const { stdout } = await execFileAsync('wsl.exe', args, {
      timeout: timeoutMs,
      windowsHide: true,
      maxBuffer: 10 * 1024 * 1024,
    })
    return stdout
  } catch (e) {
    throw new Error(`WSL 命令失败: ${(e as Error).message}`)
  }
}

/** 执行 WSL 命令（带 DISPLAY 环境变量；dbus 会话地址由 init 脚本持久化到 env 文件，
 *  使 xfconf/gsettings 等会话级工具在 exec 的全新 bash 里也能找到活面板的总线） */
export async function execWslDisplay(command: string, timeoutMs: number = WSL_TIMEOUT): Promise<string> {
  return execWslRaw(`[ -f /tmp/agent-workspace-env ] && . /tmp/agent-workspace-env; export DISPLAY=${DISPLAY}; ${command}`, timeoutMs)
}
