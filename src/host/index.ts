/**
 * agent-hostd — ximo-OS 阶段 0 入口
 *
 * 用法（Linux / WSL Debian / VM）：
 *   node dist-host/host/index.js
 * 首次启动生成访问令牌（只回显一次），驾驶舱连 ws://<host>:17890/ws?token=<令牌>
 */
import { loadConfig, ensureToken } from './config'
import { createHostServer } from './server'

async function main(): Promise<void> {
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
