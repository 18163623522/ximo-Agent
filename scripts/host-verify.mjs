#!/usr/bin/env node
/**
 * host-verify — 产物工具清点脚本（阶段 A2 防线）
 *
 * 加载 dist-host/agent-hostd.cjs（验证模式），断言 HOST_TOOL_NAMES 中的工具
 * 全部注册成功。用于拦截：
 * - import.meta 断裂导致的模块组加载失败
 * - 工具工厂名拼写错误
 * - lazy-registry 静默吞错
 *
 * 用法：node scripts/host-verify.mjs
 * 前置：npm run host:build（产物须存在）
 */
import { existsSync } from 'fs'
import { join, dirname } from 'path'
import { execFileSync } from 'child_process'
import { fileURLToPath } from 'url'

const root = process.cwd()
const bundle = join(root, 'dist-host', 'agent-hostd.cjs')

if (!existsSync(bundle)) {
  console.error('[host-verify] ❌ 产物不存在: dist-host/agent-hostd.cjs — 先执行 npm run host:build')
  process.exit(1)
}

// 用子进程运行验证模式 — 产物加载后 void main() 会调用 verifyMode()，
// verifyMode 内部调用 process.exit 退出。子进程的退出码反映验证结果。
const env = {
  ...process.env,
  XIMO_HOST_VERIFY: '1',
  XIMO_HOST_DISPLAY: '',
  XIMO_HOST_DIR: join(root, '.ximo-cache', 'host-verify'),
}

try {
  const stdout = execFileSync(process.execPath, [bundle], {
    env,
    encoding: 'utf-8',
    timeout: 30_000,
    stdio: ['ignore', 'pipe', 'inherit'],
  })
  // 打印子进程 stdout（验证模式的 console.log 输出）
  if (stdout.trim()) console.log(stdout.trim())
  if (stdout.includes('✅')) {
    process.exit(0)
  }
  process.exit(1)
} catch (e) {
  // 子进程非零退出（exit(1)）会抛异常 — 其 stdout 在 e.stdout 中
  if (e.stdout) console.log(String(e.stdout).trim())
  if (e.status === 1) {
    process.exit(1)
  }
  console.error(`[host-verify] ❌ 产物加载异常: ${e instanceof Error ? e.message : String(e)}`)
  process.exit(1)
}
