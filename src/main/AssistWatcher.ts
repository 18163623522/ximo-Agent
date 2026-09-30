/**
 * AssistWatcher — 工作分摊感知器
 *
 * 开关开启后（默认关闭，隐私敏感）：定时感知用户电脑中的工作内容
 * （窗口标题清单 + 前台画面文本大纲，不截图、不落盘），交给 LLM 判断
 * 是否存在适合后台 Agent 分担的明确工作；有则先弹窗征求用户同意，
 * 用户接受才派发 agentSystemStore.startInstance 后台执行。
 *
 * 安全设计：
 * - fail-closed：渲染窗口不存在（无弹窗渠道）时直接跳过，不派活
 * - 频控：同一观测签名 30 分钟内不重复提议（无论用户接受还是拒绝）
 * - 感知数据只在内存中流转，写入会话的只有用户接受后的任务本身
 */
import { BrowserWindow } from 'electron'
import { piBridge } from './tools/ComputerUse/PiBridge'
import { formatOutlineCompact } from './tools/ComputerUse/outline-formatters'
import { callSubAgentWithTools } from './tools/Skill/sub-agent'
import { agentSystemStore } from './AgentSystemStore'
import { loadSettings, saveSettings, loadConversations } from './store'
import { resolveActiveProvider } from './deepseek/provider'
import type { ToolContext } from '@shared/types'

/** 感知间隔 */
const CHECK_INTERVAL_MS = 10 * 60_000
/** 开启后首次检查延迟 */
const FIRST_CHECK_DELAY_MS = 45_000
/** 提议弹窗等待用户响应的超时 — 超时视为忽略 */
const PROPOSAL_TIMEOUT_MS = 120_000
/** 相同观测签名在此窗口内不重复提议 */
const DEDUP_WINDOW_MS = 30 * 60_000
/** 频控记录上限 */
const MAX_DEDUP_RECORDS = 20

export interface AssistProposal {
  id: string
  /** 一句话任务名 */
  title: string
  /** 观测依据 — 让用户知道 Agent 看到了什么 */
  observation: string
  /** 拟派发给后台 Agent 的完整任务指令 */
  proposedTask: string
}

interface AssistVerdict {
  shouldHelp: boolean
  title?: string
  observation?: string
  proposedTask?: string
}

interface DedupRecord {
  signature: string
  at: number
}

const genId = (): string => `assist_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`

/** djb2 字符串哈希 — 频控签名用，避免频控表里存明文观测内容 */
const hash = (s: string): string => {
  let h = 5381
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0
  return (h >>> 0).toString(36)
}

class AssistWatcherImpl {
  private enabled = false
  private timer: NodeJS.Timeout | null = null
  private firstCheckTimer: NodeJS.Timeout | null = null
  private analyzing = false
  private lastCheckAt = 0
  private pending = new Map<string, (accepted: boolean) => void>()
  private dedup: DedupRecord[] = []

  /** 应用启动时引导 — 读取持久化的开关状态 */
  async init(): Promise<void> {
    try {
      const s = await loadSettings()
      this.enabled = !!s.assistWatchEnabled
      if (this.enabled) this.startTimer()
    } catch { /* 设置读取失败保持关闭 */ }
  }

  isEnabled(): boolean {
    return this.enabled
  }

  getLastCheckAt(): number {
    return this.lastCheckAt
  }

  async setEnabled(on: boolean): Promise<{ enabled: boolean }> {
    this.enabled = !!on
    try {
      const s = await loadSettings()
      s.assistWatchEnabled = this.enabled
      await saveSettings(s)
    } catch (e) {
      console.warn('[AssistWatcher] 开关状态持久化失败:', (e as Error).message)
    }
    if (this.enabled) this.startTimer()
    else this.stopTimer()
    return { enabled: this.enabled }
  }

  /** 渲染层对提议的响应 — accepted=true 派发后台 Agent */
  respondProposal(proposalId: string, accepted: boolean): void {
    const resolve = this.pending.get(proposalId)
    if (resolve) {
      this.pending.delete(proposalId)
      resolve(accepted)
    }
  }

  // -----------------------------------------------------------------------

  private startTimer(): void {
    this.stopTimer()
    this.firstCheckTimer = setTimeout(() => { void this.tick() }, FIRST_CHECK_DELAY_MS)
    this.timer = setInterval(() => { void this.tick() }, CHECK_INTERVAL_MS)
  }

  private stopTimer(): void {
    if (this.firstCheckTimer) { clearTimeout(this.firstCheckTimer); this.firstCheckTimer = null }
    if (this.timer) { clearInterval(this.timer); this.timer = null }
  }

  private async tick(): Promise<void> {
    if (!this.enabled || this.analyzing) return
    this.analyzing = true
    try {
      // fail-closed — 无渲染窗口就没有弹窗渠道，不感知不提议
      const win = BrowserWindow.getAllWindows()[0]
      if (!win || win.isDestroyed()) return

      // 1) 感知 — 窗口标题 + 前台文本大纲（不截图）
      const perception = await this.perceive()
      if (!perception) return

      // 2) 频控 — 相同观测 30 分钟内不重复提议（省 LLM 调用也不打扰用户）
      const signature = hash(perception)
      if (this.isDuplicate(signature)) return

      // 3) LLM 分析 — 是否有值得分担的明确工作
      const verdict = await this.analyze(perception)
      if (!verdict || !verdict.shouldHelp || !verdict.proposedTask?.trim()) return

      const proposal: AssistProposal = {
        id: genId(),
        title: (verdict.title || '检测到可分担的工作').slice(0, 60),
        observation: (verdict.observation || '').slice(0, 300),
        proposedTask: verdict.proposedTask.slice(0, 2000),
      }

      // 4) 弹窗征求用户同意
      const accepted = await this.propose(win, proposal)
      this.remember(signature, verdict.title || '')
      if (!accepted) return

      // 5) 用户同意 — 派发后台 Agent（复用 Agent 系统实例引擎）
      const res = await agentSystemStore.startInstance({
        task: proposal.proposedTask,
        source: { scheduleId: 'assist-watcher', scheduleName: '工作分摊' },
      })
      if (!res.success) {
        console.warn('[AssistWatcher] 派发失败:', res.message)
      }
    } catch (e) {
      console.warn('[AssistWatcher] 检查失败:', (e as Error).message)
    } finally {
      this.analyzing = false
      this.lastCheckAt = Date.now()
    }
  }

  /** 感知用户电脑 — 窗口标题清单 + 前台画面文本大纲（includeImage:false，隐私足迹最小） */
  private async perceive(): Promise<string | null> {
    try {
      const roots = await piBridge.command<{ roots?: Array<{ title?: string }> }>('listRoots', {}, 10_000)
      const titles = (roots?.roots ?? []).map(r => String(r?.title || '')).filter(Boolean)
      const look = await piBridge.command<{ outline?: unknown }>('look', { readText: 'auto', includeImage: false }, 20_000)
      const outlineText = look?.outline ? formatOutlineCompact(look.outline as Record<string, unknown>) : ''
      const summary = [
        titles.length ? `当前打开的窗口：\n${titles.map(t => `- ${t}`).join('\n')}` : '',
        outlineText ? `前台画面内容大纲：\n${outlineText.slice(0, 2500)}` : '',
      ].filter(Boolean).join('\n\n')
      return summary.trim() || null
    } catch (e) {
      console.warn('[AssistWatcher] 感知失败（PiBridge 未就绪或超时）:', (e as Error).message)
      return null
    }
  }

  /** LLM 分析 — 严格 JSON 输出；无工具的子 Agent 一次性调用 */
  private async analyze(perception: string): Promise<AssistVerdict | null> {
    const settings = await loadSettings()
    const provider = resolveActiveProvider(settings)
    if (!provider.apiKey) return null

    const workContext = await this.buildRecentWorkContext()
    const systemPrompt = [
      '你是「工作分摊观察员」。根据用户电脑的窗口清单与前台画面大纲，判断是否存在一条明确、可独立完成、适合交给后台 Agent 的工作。',
      '判断原则：',
      '- 只提议画面里明确看得见的工作（正在写的文档/表格/代码/邮件等），不要凭窗口标题臆测',
      '- 保守优先：拿不准就 shouldHelp=false，宁可不打扰',
      '- 后台 Agent 看不到用户屏幕，proposedTask 必须写成自包含的完整任务指令（上下文 + 期望产出）',
      '- 不要提议涉及隐私、财务决策、发送消息/邮件等外发动作的任务',
      '严格输出 JSON，不要输出任何其他内容：',
      '不需要分担时：{"shouldHelp": false}',
      '需要分担时：{"shouldHelp": true, "title": "一句话任务名", "observation": "画面依据（简短）", "proposedTask": "给后台 Agent 的完整任务指令"}',
    ].join('\n')

    const result = await callSubAgentWithTools(
      {
        apiKey: provider.apiKey,
        baseUrl: provider.baseUrl,
        model: settings.model,
        reasoningEffort: settings.reasoningEffort ?? 'high',
        subAgentTimeout: 60,
        mode: 'office',
        autoModeLevel: 'off',
      } as ToolContext,
      systemPrompt,
      `当前电脑观测：\n\n${perception}${workContext}`,
      []
    )

    const m = result.match(/\{[\s\S]*\}/)
    if (!m) return null
    try {
      return JSON.parse(m[0]) as AssistVerdict
    } catch {
      return null
    }
  }

  /** 弹窗提议 — 无响应超时视为忽略（fail-closed） */
  private propose(win: BrowserWindow, proposal: AssistProposal): Promise<boolean> {
    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        this.pending.delete(proposal.id)
        resolve(false)
      }, PROPOSAL_TIMEOUT_MS)
      this.pending.set(proposal.id, (accepted) => {
        clearTimeout(timeout)
        resolve(accepted)
      })
      win.webContents.send('agent-assist:proposal', proposal)
    })
  }

  private isDuplicate(signature: string): boolean {
    const now = Date.now()
    this.dedup = this.dedup.filter(r => now - r.at < DEDUP_WINDOW_MS)
    return this.dedup.some(r => r.signature === signature)
  }

  private remember(signature: string, title: string): void {
    this.dedup.push({ signature, at: Date.now() })
    // 任务名也参与签名 — 同名任务换观测角度也不重复打扰
    if (title) this.dedup.push({ signature: hash(`title:${title}`), at: Date.now() })
    if (this.dedup.length > MAX_DEDUP_RECORDS * 2) {
      this.dedup = this.dedup.slice(-MAX_DEDUP_RECORDS)
    }
  }

  /** 近期会话上下文 — 轻量版（只取标题与最近一句用户输入，辅助 LLM 判断口径） */
  private async buildRecentWorkContext(): Promise<string> {
    try {
      const conversations = await loadConversations()
      const weekAgo = Date.now() - 7 * 86_400_000
      const recent = conversations
        .filter(c => c.updatedAt >= weekAgo && c.messages.length > 0 && !c.title.startsWith('['))
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .slice(0, 5)
      if (recent.length === 0) return ''
      const lines = recent.map(c => {
        const lastUser = [...c.messages].reverse().find(m => m.role === 'user')
        return `- ${c.title}${lastUser ? `（最近提到：${lastUser.content.trim().slice(0, 50)}）` : ''}`
      })
      return `\n\n用户近期对话（供参考口径，避免重复劳动）：\n${lines.join('\n')}`
    } catch {
      return ''
    }
  }
}

export const assistWatcher = new AssistWatcherImpl()
