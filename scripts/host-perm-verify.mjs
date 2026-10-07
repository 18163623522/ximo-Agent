/**
 * host-perm-verify — 权限矩阵自检（阶段 C1 / 铁门槛⑥，CI 硬断言）
 *
 * 防的是真机踩过三次的坑：工具清单里的工具没有任何权限规则 → 静默回退默认决策。
 * 主机无人值守（default=deny）下=功能不可用，且此前无任何告警。
 * 历史案例：vision_analyze / web_cache / web_research / skill_invoke（b9ee98c）。
 *
 * 断言：主机工具清单（静态 + 运行时）中每个工具在 coding 配置（主机默认模式）
 * 都有显式 allow/ask 规则；无规则者列出并 exit 1。
 *
 * 首启的权限矩阵（工具×决策）由 task-runner 在每次任务前打印（journal 可见），
 * 本脚本是它的 CI 化静态对账（无需起服务）。
 */
import { createRequire } from 'module'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { existsSync, mkdirSync } from 'fs'

const require = createRequire(import.meta.url)
const root = join(dirname(fileURLToPath(import.meta.url)), '..')

const entry = join(root, 'dist-host', 'agent-hostd.cjs')
if (!existsSync(entry)) {
  console.error('[host-perm-verify] ❌ 缺少 dist-host/agent-hostd.cjs — 先 npm run host:build')
  process.exit(1)
}

// 隔离数据目录，避免污染真实主机数据
const cache = join(root, '.ximo-cache', 'perm-verify')
if (!existsSync(cache)) mkdirSync(cache, { recursive: true })
process.env.XIMO_HOST_DIR = join(cache, 'config')
process.env.XIMO_HOST_DATA = join(cache, 'data')
process.env.XIMO_HOST_BROWSER = '1'
process.env.XIMO_SHIM_STRICT = '1'

const mod = require(entry)
if (typeof mod.runPermissionCheck !== 'function') {
  console.error('[host-perm-verify] ❌ 产物未导出 runPermissionCheck（agent-hostd 版本过旧）')
  process.exit(1)
}

const result = mod.runPermissionCheck()
console.log(`[host-perm-verify] 模式: ${result.mode}（主机默认）| 工具数: ${result.total}`)
for (const row of result.rows) {
  console.log(`[host-perm-verify]   ${String(row.decision).padEnd(5)} ${row.hasRule ? '' : '⚠无规则 '}${row.name}`)
}
if (result.noRule.length > 0) {
  console.error(`[host-perm-verify] ❌ ${result.noRule.length} 个工具无权限规则（无人值守下=不可用）: ${result.noRule.join(', ')}`)
  process.exit(1)
}
console.log(`[host-perm-verify] ✅ 全部 ${result.total} 个工具均有显式权限规则`)
process.exit(0)
