/**
 * ximo-host 配置与凭据 — 路径解析、配置加载、访问令牌
 *
 * 目录约定（Linux/XDG 优先，Windows 开发态自动回退）：
 *   配置：$XDG_CONFIG_HOME/ximo-host（config.json + token）
 *   数据：$XDG_DATA_HOME/ximo-host（tasks/ 任务转录 + workspace/ 任务工作区）
 * 环境变量 XIMO_HOST_LISTEN / XIMO_HOST_BASEURL / XIMO_HOST_APIKEY /
 * XIMO_HOST_MODEL 可覆盖 config.json，便于容器/systemd 注入。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import { randomBytes } from 'crypto'

export interface HostConfig {
  /** 监听地址 127.0.0.1:17890 — 驾驶舱跨机时改 0.0.0.0 并确保 token 强度 */
  listen: string
  baseUrl: string
  apiKey: string
  model: string
  /** 权限模式 — 决定哪些工具 allow/ask/deny（复用主应用 Permission 引擎） */
  mode: string
  /** 审批等待时长 ms，超时视为拒绝（fail-closed） */
  approvalTimeoutMs: number
  /** desktop-bus 使用的 X 显示（Xvfb 桌面会话）；空 = 桌面功能停用 */
  display: string
  /** 并发任务上限（阶段 D2：每任务 fork 子进程，工作区/白名单随进程隔离） */
  maxConcurrentTasks: number
}

export const DEFAULT_CONFIG: HostConfig = {
  listen: process.env.XIMO_HOST_LISTEN || '127.0.0.1:17890',
  baseUrl: process.env.XIMO_HOST_BASEURL || 'https://api.deepseek.com/v1',
  apiKey: process.env.XIMO_HOST_APIKEY || '',
  model: process.env.XIMO_HOST_MODEL || 'deepseek-chat',
  mode: process.env.XIMO_HOST_MODE || 'coding',
  approvalTimeoutMs: Number(process.env.XIMO_HOST_APPROVAL_TIMEOUT_MS) || 120_000,
  display: process.env.XIMO_HOST_DISPLAY ?? ':99',
  maxConcurrentTasks: Number(process.env.XIMO_HOST_MAX_CONCURRENT) || 2,
}

export function configDir(): string {
  return process.env.XIMO_HOST_DIR ||
    process.env.XDG_CONFIG_HOME ||
    join(homedir(), '.config', 'ximo-host')
}

export function dataDir(): string {
  return process.env.XIMO_HOST_DATA ||
    process.env.XDG_DATA_HOME ||
    join(homedir(), '.local', 'share', 'ximo-host')
}

export function loadConfig(): HostConfig {
  const file = join(configDir(), 'config.json')
  let fileConfig: Partial<HostConfig> = {}
  try {
    fileConfig = JSON.parse(readFileSync(file, 'utf-8'))
  } catch { /* 首次无配置文件，全走默认/环境变量 */ }
  return { ...DEFAULT_CONFIG, ...fileConfig }
}

/** 读写访问令牌 — 首次启动生成（0600），只回显一次完整值，之后只报路径 */
export function ensureToken(): { token: string; created: boolean; path: string } {
  const dir = configDir()
  mkdirSync(dir, { recursive: true })
  const path = join(dir, 'token')
  if (existsSync(path)) {
    return { token: readFileSync(path, 'utf-8').trim(), created: false, path }
  }
  const token = randomBytes(24).toString('base64url')
  writeFileSync(path, token, { mode: 0o600 })
  return { token, created: true, path }
}

export function tasksDir(): string {
  const dir = join(dataDir(), 'tasks')
  mkdirSync(dir, { recursive: true })
  return dir
}

export function workspaceDir(taskId: string): string {
  const dir = join(dataDir(), 'workspace', taskId)
  mkdirSync(dir, { recursive: true })
  return dir
}
