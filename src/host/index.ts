/**
 * agent-hostd — ximo-OS 阶段 0 入口
 *
 * 用法（Linux / WSL Debian / VM）：
 *   node dist-host/host/index.js
 * 首次启动生成访问令牌（只回显一次），驾驶舱连 ws://<host>:17890/ws?token=<令牌>
 *
 * 验证模式：XIMO_HOST_VERIFY=1 时不启动服务器，执行工具清点并退出。
 * 供 scripts/host-verify.mjs 调用（阶段 A2 防线）。
 */
import { loadConfig, ensureToken } from './config'
import { createHostServer } from './server'
import { ensureModuleGroupsLoaded, HOST_TOOL_GROUPS, HOST_TOOL_NAMES, toolRegistry } from './agent/task-runner'

async function verifyMode(): Promise<void> {
  console.log('[host-verify] 开始工具清点…')
  console.log(`[host-verify] HOST_TOOL_GROUPS: ${HOST_TOOL_GROUPS.join(', ')}`)
  console.log(`[host-verify] 预期工具数: ${HOST_TOOL_NAMES.length}`)

  try {
    // 逐个加载，便于定位失败的模块组
    for (const g of HOST_TOOL_GROUPS) {
      await ensureModuleGroupsLoaded([g])
    }
  } catch (e) {
    console.error(`[host-verify] ❌ 模块组加载失败: ${(e as Error).message}`)
    process.exit(1)
  }

  const registered = new Set<string>()
  // toolRegistry 没有遍历接口，用 getByNames 测试每个预期名
  const expected = HOST_TOOL_NAMES
  const missing: string[] = []
  for (const name of expected) {
    if (toolRegistry.has(name)) {
      registered.add(name)
    } else {
      missing.push(name)
    }
  }

  // 检测多余工具（注册了但不在预期清单中的）
  // toolRegistry 没有列出所有工具的 API，只能通过 getByNames 反推
  // 多余工具检测靠 lazy-registry 的注册日志（warn 覆盖）

  console.log(`[host-verify] 已注册工具数: ${registered.size}`)

  if (missing.length > 0) {
    console.error(`[host-verify] ❌ 缺失工具 (${missing.length}): ${missing.join(', ')}`)
    process.exit(1)
  }

  console.log(`[host-verify] ✅ 全部 ${expected.length} 个工具注册成功`)
  process.exit(0)
}

async function main(): Promise<void> {
  // 主机运行时标记 — store.saveSettings 依据它决定敏感字段是否脱敏落盘
  // （主机无真实 safeStorage，settings.json 不得保存明文 apiKey）
  process.env.XIMO_HOST_RUNTIME = '1'

  // 验证模式 — 不启动服务器，执行工具清点并退出
  if (process.env.XIMO_HOST_VERIFY === '1') {
    return verifyMode()
  }

  const config = loadConfig()
  const { token, created, path } = ensureToken()
  if (!config.apiKey) {
    console.warn('[ximo-host] ⚠️ 未配置 apiKey — 任务会失败。写入 ' + path.replace(/token$/, 'config.json'))
  }
  if (created) {
    console.log('[ximo-host] ✅ 已生成访问令牌（仅此一次回显）:')
    console.log(`[ximo-host] token = ${token}`)
  } else {
    console.log(`[ximo-host] 访问令牌: ${path}`)
  }

  const host = createHostServer({ config, token })
  await host.start()
  console.log(`[ximo-host] 监听 http://${config.listen} · WS 路径 /ws · 权限模式 ${config.mode} · 模型 ${config.model}`)

  let stopping = false
  const stop = async (): Promise<void> => {
    if (stopping) return
    stopping = true
    console.log('[ximo-host] 收到停止信号 — 取消运行中的任务并退出')
    await host.close()
    process.exit(0)
  }
  process.on('SIGINT', () => { void stop() })
  process.on('SIGTERM', () => { void stop() })
}

void main()
