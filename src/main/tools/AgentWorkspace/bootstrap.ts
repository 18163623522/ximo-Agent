/**
 * bootstrap — Windows/WSL 引导层（无状态）
 *
 * WSL 功能检测与启用（dism/管理员提权）、Debian 发行版检测/安装/首启、
 * WSL 版本读取与降级、CPU 虚拟化预检。供 AgentWorkspaceManager 的
 * start() 引导编排调用；本模块不持有可变单例状态（仅 installDistro
 * 的 lastInstallError 以模块级变量保存，经 getLastInstallError() 对外只读）。
 */

import { execFile } from 'child_process'
import { promisify } from 'util'
import { join } from 'path'
import { decodeWslOutput, matchWslVirtualizationError } from './wsl-decode'
import { WSL_DISTRIBUTION } from './wsl-exec'

const execFileAsync = promisify(execFile)

/** wsl.exe 绝对路径 — 打包版从资源管理器启动时 PATH 环境可能与开发态不同，绝对路径最稳 */
const WSL_EXE = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'wsl.exe')

/** 最近一次发行版安装失败的解码后原因 — 透传到面板错误提示 */
let lastInstallError = ''

/** 读取最近一次发行版安装失败的解码后原因 */
export function getLastInstallError(): string {
  return lastInstallError
}

// -----------------------------------------------------------------------
// WSL 功能检测与启用（Windows 层面）
// -----------------------------------------------------------------------

/** 检测 WSL 功能是否已启用 */
export async function isWslFeatureEnabled(): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync('dism.exe', [
      '/online', '/get-featureinfo', '/featurename:Microsoft-Windows-Subsystem-Linux'
    ], { timeout: 15_000, windowsHide: true })
    return stdout.includes('状态 : 已启用') || stdout.includes('State : Enabled')
  } catch {
    return false
  }
}

/** 检测虚拟机平台是否已启用 */
export async function isVmPlatformEnabled(): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync('dism.exe', [
      '/online', '/get-featureinfo', '/featurename:VirtualMachinePlatform'
    ], { timeout: 15_000, windowsHide: true })
    return stdout.includes('状态 : 已启用') || stdout.includes('State : Enabled')
  } catch {
    return false
  }
}

/** 检测当前进程是否有管理员权限
 *  方法：用 whoami /groups 检测 S-1-5-32-544 (Administrators SID) 是否处于 Enabled 状态
 *  比 net session 更可靠（net session 在某些 Windows 版本上即使管理员也会失败）
 */
export async function isAdmin(): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-Command',
      '(New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)'
    ], { timeout: 10_000, windowsHide: true })
    return stdout.trim().toLowerCase() === 'true'
  } catch {
    return false
  }
}

export interface ElevateResult {
  ok: boolean
  /** 提权执行的输出日志 — 失败时的诊断来源（UAC 路径父子进程无管道，输出必须落盘才能回收） */
  log: string
  /** 进程退出码（-1 = 未能取得） */
  exitCode: number
}

/**
 * 以管理员权限执行命令
 * 如果当前已是管理员 → 直接执行 .bat（不弹 UAC）
 * 如果当前非管理员 → 用 Start-Process -Verb RunAs 触发 UAC 提权弹窗
 *
 * 两条路径的输出都重定向到日志文件并随结果返回。打包版静默失败的教训：
 * 此前 UAC 路径丢弃全部输出、失败只返回 false，面板只能显示"安装失败"没有原因。
 *
 * @param command 完整命令行（如 'dism.exe /online /enable-feature ...'）
 * @param timeoutMs 提权执行的超时（大文件下载类命令需要放宽）
 */
export async function runAsAdmin(command: string, timeoutMs = 180_000): Promise<ElevateResult> {
  const fs = await import('fs')
  const path = await import('path')
  const os = await import('os')

  const batPath = path.join(os.tmpdir(), `agent-wsl-elev-${Date.now()}.bat`)
  const logPath = `${batPath}.log`
  // 输出统一重定向到日志 — 提权进程的 stdout/stderr 无法经管道回收
  const batContent = `@echo off\r\n${command} > "${logPath}" 2>&1\r\nexit /b %errorlevel%\r\n`
  const readLog = (): string => {
    try { return fs.readFileSync(logPath, 'utf8').replace(/\s+/g, ' ').trim().slice(0, 800) } catch { return '' }
  }
  const cleanup = (): void => {
    try { fs.unlinkSync(batPath) } catch { /* 忽略 */ }
    try { fs.unlinkSync(logPath) } catch { /* 忽略 */ }
  }

  try {
    fs.writeFileSync(batPath, batContent, { encoding: 'utf8' })

    // 先检测是否已经是管理员
    const admin = await isAdmin()
    console.log('[AgentWorkspace] isAdmin:', admin, '| bat:', batPath)

    if (admin) {
      // 已是管理员 — 直接执行 .bat，不走 RunAs
      let exitCode = 0
      try {
        await execFileAsync('cmd.exe', ['/c', batPath], {
          timeout: timeoutMs, windowsHide: true,
          maxBuffer: 10 * 1024 * 1024,
        })
      } catch (e) {
        // dism 退出码 3010 = ERROR_SUCCESS_REBOOT_REQUIRED（成功但需要重启）
        const err = e as { code?: number; message: string }
        exitCode = err.code ?? -1
        const text = readLog() || (err.message || '').replace(/\s+/g, ' ').trim()
        console.log('[AgentWorkspace] bat exit code:', exitCode, '|', text.slice(0, 300))
        if (exitCode !== 0 && exitCode !== 3010) {
          cleanup()
          // "已启用/already" 幂等成功
          if (/已启用|already|成功/.test(text)) return { ok: true, log: text, exitCode }
          return { ok: false, log: text, exitCode }
        }
      }
      cleanup()
      return { ok: true, log: readLog(), exitCode }
    }

    // 非管理员 — 用 Start-Process -Verb RunAs 触发 UAC
    const psScript = `$p = Start-Process -FilePath '${batPath.replace(/'/g, "''")}' -Verb RunAs -Wait -WindowStyle Hidden -PassThru; exit $p.ExitCode`
    let exitCode = 0
    try {
      await execFileAsync('powershell.exe', [
        '-NoProfile', '-NonInteractive', '-Command', psScript
      ], { timeout: timeoutMs, windowsHide: true })
    } catch (e) {
      const err = e as { code?: number; message: string }
      exitCode = err.code ?? -1
      const msg = err.message || ''
      console.error('[AgentWorkspace] runAsAdmin error:', msg.slice(0, 500))
      if (msg.includes('1223') || msg.includes('用户取消') || msg.includes('canceled')) {
        cleanup()
        return { ok: false, log: '用户拒绝了 UAC 提权（或被安全软件/组策略拦截）', exitCode }
      }
      // 其他 PowerShell 层错误 — 继续尝试读 bat 日志拿真实原因
    }
    const log = readLog()
    cleanup()
    // 3010 = 成功但需要重启
    return { ok: exitCode === 0 || exitCode === 3010, log, exitCode }
  } catch (e) {
    const msg = (e as Error).message || ''
    console.error('[AgentWorkspace] runAsAdmin error:', msg.slice(0, 500))
    cleanup()
    return { ok: false, log: msg.slice(0, 800), exitCode: -1 }
  }
}

/**
 * 启用 WSL 功能 + 虚拟机平台
 * 总是通过 runAsAdmin 提权执行（如果已是管理员则不弹 UAC，直接执行）
 */
export async function enableWslFeature(): Promise<boolean> {
  // 两条 dism 命令用 && 连接
  const dismCmd = 'dism.exe /online /enable-feature /featurename:Microsoft-Windows-Subsystem-Linux /all /norestart && dism.exe /online /enable-feature /featurename:VirtualMachinePlatform /all /norestart'
  const r = await runAsAdmin(dismCmd)
  if (!r.ok) {
    console.warn('[AgentWorkspace] WSL 功能启用失败:', r.log || `退出码 ${r.exitCode}`)
  }
  return r.ok
}

// -----------------------------------------------------------------------
// Ubuntu 发行版检测与安装
// -----------------------------------------------------------------------

/** 检测是否有 Debian 发行版已安装 */
export async function hasDistro(): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync(WSL_EXE, ['-l', '-q'], {
      timeout: 10_000, windowsHide: true, encoding: 'buffer'
    })
    // wsl.exe 输出是 UTF-16LE — 必须 buffer 接收后解码（见 wsl-decode.ts）
    return decodeWslOutput(stdout as Buffer).toLowerCase().includes('debian')
  } catch {
    return false
  }
}

/** 检测 WSL 是否可正常运行（功能已生效） */
export async function isWslFunctional(): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync(WSL_EXE, ['--status'], {
      timeout: 5_000, windowsHide: true, encoding: 'buffer'
    })
    // 如果 WSL 功能未生效，会输出 "此应用程序需要…"
    const text = decodeWslOutput(stdout as Buffer)
    return !text.includes('需要') && !text.includes('WSL_E_WSL_OPTIONAL_COMPONENT_REQUIRED')
  } catch {
    return false
  }
}

/** 从 wsl.exe 的失败结果中提取可读文本 — 输出是 UTF-16LE buffer，须解码 */
export function wslErrorText(e: unknown): string {
  const err = e as { stdout?: unknown; stderr?: unknown; message?: string }
  const parts = [err.stdout, err.stderr].map((b) => (Buffer.isBuffer(b) ? decodeWslOutput(b) : String(b ?? '')))
  parts.push(err.message ?? '')
  return parts.join(' ').replace(/\s+/g, ' ').trim().slice(0, 300)
}

/** 安装 Debian 发行版（不自动启动，自动处理管理员权限）。
 *  下载约 300MB 且不续传 — 超时放宽到 15 分钟；Store 渠道失败后追加
 *  --web-download 直连 CDN 重试一次。
 *  策略：先免提权直装（现代 WSL 功能启用后装发行版不需要管理员 — 打包版从
 *  资源管理器启动是非管理员，免提权可避开 UAC 弹窗被拒/被安全软件拦截的
 *  静默失败），失败再 UAC 提权重试；每次失败原因都落入 lastInstallError。 */
export async function installDistro(): Promise<boolean> {
  const admin = await isAdmin()
  const attempts: string[][] = [
    ['--install', '-d', WSL_DISTRIBUTION, '--no-launch'],
    ['--install', '-d', WSL_DISTRIBUTION, '--no-launch', '--web-download'],
  ]
  const alreadyInstalled = (t: string): boolean => t.includes('已安装') || /already installed/i.test(t)

  for (const args of attempts) {
    const channel = args.includes('--web-download') ? 'CDN 直连' : 'Store'

    // 1) 免提权直装（管理员用户下即等同原直装路径）
    try {
      await execFileAsync(WSL_EXE, args, {
        timeout: 900_000,
        windowsHide: true,
        maxBuffer: 10 * 1024 * 1024,
        encoding: 'buffer',
      })
      return true
    } catch (e) {
      const text = wslErrorText(e)
      if (alreadyInstalled(text)) return true
      console.warn(`[AgentWorkspace] wsl install 失败[${channel} 直装]:`, text)
      const vzError = matchWslVirtualizationError(text)
      if (vzError) {
        // 虚拟化不可用 — 换下载渠道重装也无法解决，直接报错
        lastInstallError = vzError
        return false
      }
      lastInstallError = `[${channel} 直装] ${text}`
    }

    // 2) 非管理员 — UAC 提权重试（提权输出落日志随结果返回，失败原因可见）
    if (!admin) {
      const r = await runAsAdmin(`${WSL_EXE} ${args.join(' ')}`, 900_000)
      if (r.ok || alreadyInstalled(r.log)) return true
      lastInstallError = `[${channel} 提权] ${r.log || `退出码 ${r.exitCode}`}`
      console.warn(`[AgentWorkspace] wsl install 失败[${channel} 提权]:`, lastInstallError)
    }
  }
  return false
}

/** 首次初始化 Debian（设置 root 默认用户，跳过交互式设置） */
export async function firstBootDistro(): Promise<boolean> {
  try {
    // 以 root 身份执行一次，触发 WSL 初始化
    // --exec 跳过默认用户登录，直接用 root
    await execFileAsync(WSL_EXE, [
      '-d', WSL_DISTRIBUTION, '--exec', 'bash', '-c', 'echo OK'
    ], { timeout: 30_000, windowsHide: true })

    // 设置默认用户为 root（避免交互式用户创建）
    await execFileAsync(WSL_EXE, [
      '-d', WSL_DISTRIBUTION, '--exec', 'bash', '-c',
      'echo "[user]\ndefault=root" > /etc/wsl.conf'
    ], { timeout: 10_000, windowsHide: true })

    // 重启 WSL 使配置生效
    await execFileAsync(WSL_EXE, ['--terminate', WSL_DISTRIBUTION], {
      timeout: 10_000, windowsHide: true
    })

    await new Promise(r => setTimeout(r, 2000))

    return true
  } catch {
    return false
  }
}

// -----------------------------------------------------------------------
// WSL 命令执行
// -----------------------------------------------------------------------

/** 读取已注册发行版的 WSL 版本（未注册返回 0） */
export async function getDistroVersion(): Promise<number> {
  try {
    const { stdout } = await execFileAsync(WSL_EXE, ['-l', '-v'], {
      timeout: 15_000, windowsHide: true, encoding: 'buffer'
    })
    const m = decodeWslOutput(stdout as Buffer).match(/Debian\s+\S+\s+(\d)\s*$/m)
    return m ? Number(m[1]) : 0
  } catch {
    return 0
  }
}

/** 降级 WSL1 — 纯系统调用翻译，无需 CPU 虚拟化。
 *  默认版本切 1；若发行版此前已注册为 WSL2（罕见：开过 VT）则转换为 WSL1（可能数分钟）。 */
export async function switchToWsl1(): Promise<boolean> {
  try {
    await execFileAsync(WSL_EXE, ['--set-default-version', '1'], {
      timeout: 15_000, windowsHide: true, encoding: 'buffer'
    })
    if ((await getDistroVersion()) === 2) {
      await execFileAsync(WSL_EXE, ['--set-version', WSL_DISTRIBUTION, '1'], {
        timeout: 600_000, windowsHide: true, maxBuffer: 10 * 1024 * 1024, encoding: 'buffer'
      })
    }
    return true
  } catch (e) {
    console.warn('[AgentWorkspace] WSL1 切换失败:', wslErrorText(e))
    return false
  }
}

/** 预检 CPU 虚拟化是否可用（BIOS 已开 VT-x/AMD-V 或 Hypervisor 已运行）。
 *  不满足时 WSL2 无法创建 VM — 调用方会自动降级 WSL1，避免白下 300MB 发行版。
 *  检测本身失败时保守放行，让 wsl 自己报错。 */
export async function isVirtualizationAvailable(): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-Command',
      '(Get-CimInstance Win32_Processor).VirtualizationFirmwareEnabled; (Get-CimInstance Win32_ComputerSystem).HypervisorPresent'
    ], { timeout: 15_000, windowsHide: true })
    return /true/i.test(stdout)
  } catch {
    return true
  }
}
