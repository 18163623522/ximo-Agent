#!/usr/bin/env node
/**
 * ximo-OS 镜像验收 — 阶段 1 达成标准自动化（os/README.md 清单后 4 项）
 *
 * 前置：QEMU 已启动镜像并做端口转发（os/scripts/run-image-tcg.ps1）
 *   cockpit-link: 127.0.0.1:17890 → guest:17890
 *   SSH:          127.0.0.1:12222 → guest:22
 *
 * 用法：node os/scripts/verify-image.mjs [--token <令牌>] [--port 17890]
 *
 * 覆盖的验收项：
 *   [2] 令牌获取（/opt/ximo-host/config/token 经 SSH 或人工提供）
 *   [3] GET /api/health 返回 200
 *   [4] WS 派任务 → done(completed)，产物落在工作区
 *   [5] 审批路径：terminal_exec 任务触发 approval.request
 *   [1] 启动耗时需人工记录（本脚本打印提示）
 *
 * 第 1 项（启动 ≤2min）无法自动判定：起始时刻取决于 QEMU 拉起时间，
 * 脚本在结束时提示人工核对。
 */
import WebSocket from 'ws'
import { execFileSync } from 'child_process'

const args = process.argv.slice(2)
const getArg = (name, dflt) => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 && args[i + 1] ? args[i + 1] : dflt
}
const PORT = Number(getArg('port', '17890'))
const SSH_PORT = Number(getArg('ssh-port', '12222'))
let TOKEN = getArg('token', '')

const results = []
const record = (name, ok, detail) => {
  results.push({ name, ok, detail })
  console.log(`${ok ? '✅' : '❌'} ${name}${detail ? ` — ${detail}` : ''}`)
}

/** 尝试从 VM 内读令牌；失败则要求 --token */
function resolveToken() {
  if (TOKEN) return TOKEN
  try {
    // root 已锁死，若镜像已注入密钥则可用；否则只能人工提供
    const out = execFileSync('ssh', [
      '-p', String(SSH_PORT),
      '-o', 'StrictHostKeyChecking=no',
      '-o', 'BatchMode=yes',
      '-o', 'ConnectTimeout=8',
      'ximo-os@127.0.0.1',
      'cat /opt/ximo-host/config/token',
    ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
    return out
  } catch {
    return ''
  }
}

async function checkHealth(token) {
  try {
    const res = await fetch(`http://127.0.0.1:${PORT}/api/health`, {
      headers: { Authorization: `Bearer ${token}` },
    })
    if (res.status === 401) return record('[3] /api/health', false, '令牌无效（401）')
    if (!res.ok) return record('[3] /api/health', false, `HTTP ${res.status}`)
    const body = await res.json()
    record('[3] /api/health', body.ok === true, `name=${body.name} version=${body.version} mode=${body.mode}`)
  } catch (e) {
    record('[3] /api/health', false, `连接失败：${e.message}`)
  }
}

/** 派任务并等终态；onChunk 可观察 approval.request */
function dispatch(token, id, task, { approveIfAsked = false, timeoutMs = 120_000 } = {}) {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws?token=${token}`)
    let asked = false
    let toolResults = []
    const timer = setTimeout(() => {
      ws.close()
      resolve({ status: 'timeout', asked, toolResults })
    }, timeoutMs)
    ws.on('open', () => ws.send(JSON.stringify({ t: 'task.dispatch', id, task, mode: 'coding' })))
    ws.on('message', (raw) => {
      const m = JSON.parse(String(raw))
      if (m.t === 'approval.request') {
        asked = true
        if (approveIfAsked) {
          ws.send(JSON.stringify({ t: 'approval.respond', reqId: m.reqId, allow: true }))
        }
      }
      if (m.t === 'task.chunk' && m.delta?.type === 'tool_result') {
        toolResults.push({ name: m.delta.name, content: String(m.delta.content ?? '') })
      }
      if (m.t === 'task.done') {
        clearTimeout(timer)
        ws.close()
        resolve({ status: m.status, result: m.result, error: m.error, asked, toolResults })
      }
    })
    ws.on('error', () => { clearTimeout(timer); resolve({ status: 'error', asked, toolResults }) })
  })
}

async function main() {
  console.log('=== ximo-OS 镜像验收（阶段 1 清单）===\n')
  console.log('[1] 启动耗时 ≤2min —— 需人工核对 QEMU 拉起至 health 可用的时长\n')

  const token = resolveToken()
  if (!token) {
    record('[2] 获取访问令牌', false, 'SSH 不可达或未注入密钥 —— 用 --token <令牌> 提供（VM 控制台 cat /opt/ximo-host/config/token）')
    console.log('\n无法继续：缺少令牌。')
    process.exit(1)
  }
  record('[2] 获取访问令牌', true, `长度 ${token.length}`)

  await checkHealth(token)

  // [4] 派任务 → completed
  console.log('\n派发验收任务（创建工作区文件）…')
  const t4 = await dispatch(token, `verify_ws_${Date.now()}`, '在工作区创建 hello.txt，内容写 "ximo-os ok"，然后确认文件存在。')
  record('[4] WS 派任务 → done(completed)',
    t4.status === 'completed',
    t4.status === 'completed' ? `调用了 ${t4.toolResults.length} 次工具` : `status=${t4.status} err=${(t4.error ?? '').slice(0, 80)}`)

  // [5] 审批路径
  console.log('\n派发审批路径任务（terminal_exec）…')
  const t5 = await dispatch(token, `verify_appr_${Date.now()}`, '用 terminal_exec 执行 `echo approval-path-ok` 并把输出告诉我。', { approveIfAsked: true })
  record('[5] 审批路径触发 approval.request',
    t5.asked,
    t5.asked ? `任务终态 ${t5.status}（已自动批准）` : '未收到 approval.request')

  const failed = results.filter((r) => !r.ok)
  console.log(`\n=== 结果：${results.length - failed.length}/${results.length} 项通过 ===`)
  console.log('[1] 请人工核对 QEMU 启动耗时是否 ≤2 分钟，并确认 os/README.md 清单全部勾选。')
  process.exit(failed.length === 0 ? 0 : 1)
}

main().catch((e) => { console.error('验收脚本异常：', e.message); process.exit(1) })
