/**
 * AgentSystemStore — Agent 定义库 + 后台实例引擎
 *
 * 实例执行复用 callSubAgentWithTools（无头、非流式、返回最终文本、自带轮次/压缩/超时/权限），
 * 每次调用即独立实例，天然并行；结果写回会话（loadConversations→追加→saveConversations），
 * 并推送 conversation:updated 让渲染层 reload —— 否则渲染层下一次 _persist 全量覆盖会丢数据。
 * 完成时弹系统通知（照 chat-handler 的失焦通知范式）。
 */
import { BrowserWindow, Notification } from 'electron'
import * as http from 'http'
import { loadConversations, saveConversations, loadSettings } from './store'
import { resolveActiveProvider } from './deepseek/provider'
import { ensureModeToolsLoaded, modeToolNames } from './tools/lazy-registry'
import { callSubAgentWithTools } from './tools/Skill/sub-agent'
import type { AgentDefinition, AgentInstance } from '@shared/agent-definition'
import { DEFAULT_AGENT_ID } from '@shared/agent-definition'
import type { ChatMessage, StreamChunk, ToolContext } from '@shared/types'
import { DefinitionStore } from './AgentSystem/DefinitionStore'
import { InstanceRegistry } from './AgentSystem/InstanceRegistry'
import { buildWorkContext } from './AgentSystem/work-context'
import { genId } from './AgentSystem/gen-id'

const MAX_CONCURRENT = 3
const WEBHOOK_PORT = 17888

interface InstanceDraft {
  agentId?: string
  task: string
  source?: { scheduleId: string; scheduleName: string }
}

/** 桌面互斥队列项 — 桌面实例共享同一 Xvfb 显示器，一次只能跑一个 */
interface QueuedRun {
  instanceId: string
  def: AgentDefinition
  task: string
  source?: { scheduleId: string; scheduleName: string }
}

class AgentSystemStoreImpl {
  private defs = new DefinitionStore()
  private registry = new InstanceRegistry()
  private controllers = new Map<string, AbortController>()
  private desktopQueue: QueuedRun[] = []
  private webhookServer: http.Server | null = null

  private pushInstanceUpdate(): void {
    const win = BrowserWindow.getAllWindows()[0]
    if (win && !win.isDestroyed()) win.webContents.send('agent-instance:updated')
  }

  private pushConversationUpdated(): void {
    const win = BrowserWindow.getAllWindows()[0]
    if (win && !win.isDestroyed()) win.webContents.send('conversation:updated')
  }

  private notify(title: string, body: string): void {
    try {
      if (!Notification.isSupported()) return
      const notif = new Notification({ title, body: body.slice(0, 120), silent: false })
      notif.on('click', () => {
        const win = BrowserWindow.getAllWindows()[0]
        if (win && !win.isDestroyed()) win.focus()
      })
      notif.show()
    } catch { /* 通知失败静默 */ }
  }

  // -----------------------------------------------------------------------
  // 对外 API — 委托定义库 / 实例注册表
  // -----------------------------------------------------------------------

  async listDefinitions(): Promise<AgentDefinition[]> {
    return this.defs.listDefinitions()
  }

  async createDefinition(draft: Omit<AgentDefinition, 'id'>): Promise<AgentDefinition | null> {
    return this.defs.createDefinition(draft)
  }

  async updateDefinition(id: string, patch: Omit<AgentDefinition, 'id'>): Promise<AgentDefinition | null> {
    return this.defs.updateDefinition(id, patch)
  }

  async deleteDefinition(id: string): Promise<void> {
    return this.defs.deleteDefinition(id)
  }

  async listInstances(): Promise<AgentInstance[]> {
    return this.registry.listInstances()
  }

  // -----------------------------------------------------------------------
  // 实例引擎
  // -----------------------------------------------------------------------

  /** 启动后台实例 — 创建会话 → 无头执行 → 结果写回会话。立即返回，执行异步进行 */
  async startInstance(draft: InstanceDraft): Promise<{ success: boolean; instance?: AgentInstance; message?: string }> {
    await this.defs.loadDefinitions()
    await this.registry.loadInstances()

    const task = draft.task.trim()
    if (!task) return { success: false, message: '任务内容为空' }

    const running = this.registry.instances.filter((i) => i.status === 'running')
    if (running.length >= MAX_CONCURRENT) {
      return { success: false, message: `并行实例已达上限（${MAX_CONCURRENT}），请等待其中一个完成` }
    }

    const def = this.defs.definitions.find((d) => d.id === draft.agentId) ?? this.defs.definitions.find((d) => d.id === DEFAULT_AGENT_ID) ?? this.defs.definitions[0]
    if (!def) return { success: false, message: '没有可用的 Agent 定义' }

    // 桌面互斥 — 桌面实例共享同一 Xvfb 显示器，一次只能跑一个，其余进入队列
    const desktopBusy = this.registry.instances.some((i) => {
      if (i.status !== 'running') return false
      return this.defs.definitions.find((x) => x.id === i.agentId)?.useDesktop ?? false
    }) || this.registry.instances.some((i) => i.status === 'queued')
    const needQueue = def.useDesktop && (desktopBusy || this.desktopQueue.length > 0)

    // 创建会话 — 结果与过程留在会话列表里，标题冠以 Agent 名便于辨识
    const now = Date.now()
    const conversationId = genId('conv')
    const conversations = await loadConversations()
    const userMsg: ChatMessage = { id: genId('msg'), role: 'user', content: task, timestamp: now }
    conversations.push({
      id: conversationId,
      title: `[${def.name}] ${task.slice(0, 24)}`,
      mode: 'office',
      messages: [userMsg],
      createdAt: now,
      updatedAt: now,
    })
    await saveConversations(conversations)

    const instance: AgentInstance = {
      id: genId('ins'),
      agentId: def.id,
      agentName: def.name,
      task,
      conversationId,
      status: needQueue ? 'queued' : 'running',
      startedAt: now,
      source: draft.source,
    }
    this.registry.instances.unshift(instance)

    if (needQueue) {
      this.desktopQueue.push({ instanceId: instance.id, def, task, source: draft.source })
      await this.registry.saveInstances()
      this.pushInstanceUpdate()
      this.pushConversationUpdated()
      return { success: true, instance }
    }

    await this.registry.saveInstances()
    this.pushInstanceUpdate()
    this.pushConversationUpdated()

    // 异步执行 — 不阻塞调用方
    void this.runInstance(instance, def, task)
    return { success: true, instance }
  }

  private async runInstance(instance: AgentInstance, def: AgentDefinition, task: string): Promise<void> {
    const controller = new AbortController()
    this.controllers.set(instance.id, controller)

    // 工具调用轨迹 — 写回会话的 assistant 消息 segments，主聊天里可见工具卡
    const toolCalls: { name: string; status: 'calling' | 'done'; args?: string; result?: string; toolCallId?: string }[] = []
    const usage = { prompt: 0, completion: 0, total: 0 }
    // 实时活动流 — 当前动作推送到面板实例行
    const pushActivity = (activity: string): void => {
      instance.activity = activity
      const win = BrowserWindow.getAllWindows()[0]
      if (win && !win.isDestroyed()) win.webContents.send('agent-instance:activity', { instanceId: instance.id, activity })
    }
    const onChunk = (chunk: StreamChunk): void => {
      if (chunk.usage) {
        usage.prompt += chunk.usage.promptTokens
        usage.completion += chunk.usage.completionTokens
        usage.total += chunk.usage.totalTokens
        instance.tokens = { ...usage }
      }
      if (chunk.toolCall) {
        const argPreview = typeof chunk.toolCall.arguments === 'string'
          ? chunk.toolCall.arguments
          : JSON.stringify(chunk.toolCall.arguments) ?? ''
        pushActivity(`▶ ${chunk.toolCall.name} ${argPreview.slice(0, 60)}`)
        toolCalls.push({
          name: chunk.toolCall.name,
          status: 'calling',
          args: typeof chunk.toolCall.arguments === 'string'
            ? chunk.toolCall.arguments
            : JSON.stringify(chunk.toolCall.arguments)?.slice(0, 2000),
          toolCallId: chunk.toolCall.id,
        })
      }
      if (chunk.toolResult) {
        pushActivity(`✓ ${chunk.toolResult.toolName}`)
        const target = [...toolCalls].reverse().find((t) =>
          (chunk.toolResult?.toolCallId && t.toolCallId === chunk.toolResult?.toolCallId) ||
          (!chunk.toolResult?.toolCallId && t.name === chunk.toolName && t.status === 'calling')
        )
        if (target) {
          target.status = 'done'
          target.result = chunk.toolResult.content?.slice(0, 2000)
        } else {
          toolCalls.push({ name: chunk.toolResult.toolName, status: 'done', result: chunk.toolResult.content?.slice(0, 2000), toolCallId: chunk.toolResult.toolCallId })
        }
      }
    }

    try {
      // Agent 实例独立于三模式体系 — 统一使用完整通用工具集（office 工具域，含桌面/终端/文件/联网）
      await ensureModeToolsLoaded('office')
      const settings = await loadSettings()
      const provider = resolveActiveProvider(settings)

      const toolContext: ToolContext = {
        apiKey: provider.apiKey,
        baseUrl: provider.baseUrl,
        model: settings.model,
        reasoningEffort: settings.reasoningEffort ?? 'high',
        subAgentMaxTokens: 393216,
        subAgentTemperature: settings.subAgentTemperature ?? 0.7,
        subAgentTimeout: settings.subAgentTimeout ?? 60,
        subAgentReasoningEffort: settings.subAgentReasoningEffort ?? 'high',
        terminalTimeout: settings.terminalTimeout ?? 60,
        codeExecTimeout: settings.codeExecTimeout ?? 60,
        terminalOutputLimit: settings.terminalOutputLimit ?? 50000,
        browserHeadless: settings.browserHeadless ?? true,
        browserIdleTimeout: settings.browserIdleTimeout ?? 5,
        browserViewportWidth: settings.browserViewportWidth ?? 1280,
        browserViewportHeight: settings.browserViewportHeight ?? 800,
        defaultSearchEngine: settings.defaultSearchEngine ?? 'bing',
        searchResultsCount: settings.searchResultsCount ?? 5,
        webFetchMaxLength: settings.webFetchMaxLength ?? 5000,
        webCacheEnabled: settings.webCacheEnabled ?? true,
        webCacheMaxSizeMB: settings.webCacheMaxSizeMB ?? 100,
        helperCommandTimeout: settings.helperCommandTimeout ?? 30,
        mcpConnectTimeout: settings.mcpConnectTimeout ?? 30,
        visionApiKey: settings.visionApiKey ?? '',
        visionBaseUrl: settings.visionBaseUrl ?? 'https://api.agnes-ai.cn/v1',
        visionModel: settings.visionModel ?? 'agnes-2.5-flash',
        mode: 'office',
        // 后台无头运行：无确认弹窗渠道 — autoApprove 走 yolo，否则 fail-closed（ask 类操作被拒绝并记录）
        autoModeLevel: def.autoApprove ? 'yolo' : 'off',
      }

      const workContext = await buildWorkContext(this.registry.instances)
      const systemPrompt = [
        `你是「${def.name}」— ${def.description}`,
        def.systemPrompt ? `职责与工作方式：\n${def.systemPrompt}` : '',
        def.useDesktop ? '任务在隔离图形桌面（1280x800，Xvfb :99，带任务栏和终端）中执行：使用 wsl_desktop 工具操作与截图。桌面内缺少的软件可用命令自行安装。' : '',
        '工作要求：独立完成任务（用户不会实时在线）；需要决策时选择安全合理的默认方案并在汇报中说明；最终给出简洁清晰的结果汇报。',
        workContext
      ].filter(Boolean).join('\n\n')

      const result = await callSubAgentWithTools(
        toolContext,
        systemPrompt,
        task,
        modeToolNames.office ?? [],
        onChunk,
        controller.signal
      )

      instance.status = 'completed'
      instance.finishedAt = Date.now()
      instance.resultPreview = result.slice(0, 300)

      const assistantMsg: ChatMessage = {
        id: genId('msg'),
        role: 'assistant',
        content: result,
        timestamp: Date.now(),
        ...(toolCalls.length > 0 ? { segments: [{ reasoning: '', content: result, toolCalls }] } : {}),
      }
      await this.appendConversationMessages(instance.conversationId, [assistantMsg])
      this.notify(`${def.emoji || '🤖'} ${def.name} · 任务完成`, result.slice(0, 120))
    } catch (e) {
      const aborted = controller.signal.aborted
      instance.status = 'error'
      instance.finishedAt = Date.now()
      instance.error = aborted ? '已手动中止' : (e as Error).message.slice(0, 300)
      const errMsg: ChatMessage = {
        id: genId('msg'),
        role: 'assistant',
        content: aborted ? '⚠️ 任务已手动中止。' : `⚠️ 任务执行失败：${(e as Error).message}`,
        timestamp: Date.now(),
      }
      await this.appendConversationMessages(instance.conversationId, [errMsg]).catch(() => {})
      this.notify(`${def.name} · 任务${aborted ? '已中止' : '失败'}`, instance.error.slice(0, 120))
    } finally {
      this.controllers.delete(instance.id)
      instance.activity = undefined
      await this.registry.saveInstances()
      this.pushInstanceUpdate()
      this.pushConversationUpdated()
      // 桌面互斥队列 — 上一个完成后启动下一个排队的桌面实例
      this.pumpQueue()
    }
  }

  /** 桌面队列出队 — 启动下一个排队的桌面实例 */
  private pumpQueue(): void {
    const next = this.desktopQueue.shift()
    if (!next) return
    const ins = this.registry.instances.find((i) => i.id === next.instanceId)
    if (!ins || ins.status !== 'queued') {
      this.pumpQueue()
      return
    }
    ins.status = 'running'
    this.pushInstanceUpdate()
    void this.runInstance(ins, next.def, next.task)
  }

  /** 中止实例 — 运行中的 abort；排队中的移出队列并标记取消 */
  stopInstance(id: string): { success: boolean } {
    const queuedIdx = this.desktopQueue.findIndex((q) => q.instanceId === id)
    if (queuedIdx !== -1) {
      this.desktopQueue.splice(queuedIdx, 1)
      const ins = this.registry.instances.find((i) => i.id === id)
      if (ins) {
        ins.status = 'error'
        ins.error = '已取消（排队中移除）'
        ins.finishedAt = Date.now()
      }
      void this.registry.saveInstances()
      this.pushInstanceUpdate()
      return { success: true }
    }
    const controller = this.controllers.get(id)
    if (!controller) return { success: false }
    controller.abort()
    return { success: true }
  }

  /** 本地 Webhook 触发 — POST http://127.0.0.1:17888/fire  {"agentId?":"...","task":"..."}（仅监听回环地址） */
  startWebhookServer(): void {
    if (this.webhookServer) return
    try {
      const server = http.createServer((req, res) => { void this.handleWebhook(req, res) })
      server.on('error', (e) => console.warn('[AgentSystem] Webhook 端口被占用，触发端点未启用:', (e as Error).message))
      server.listen(WEBHOOK_PORT, '127.0.0.1', () => {
        console.log(`[AgentSystem] Webhook 就绪: http://127.0.0.1:${WEBHOOK_PORT}/fire`)
      })
      this.webhookServer = server
    } catch (e) {
      console.warn('[AgentSystem] Webhook 启动失败:', (e as Error).message)
    }
  }

  private async handleWebhook(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    res.setHeader('Content-Type', 'application/json')
    if (req.method !== 'POST' || req.url?.split('?')[0] !== '/fire') {
      res.writeHead(404).end(JSON.stringify({ success: false, message: '仅支持 POST /fire' }))
      return
    }
    let body = ''
    req.on('data', (c: Buffer) => {
      body += c.toString('utf8')
      if (body.length > 1_000_000) req.destroy()
    })
    req.on('end', () => {
      void (async () => {
        try {
          const { agentId, task } = JSON.parse(body || '{}') as { agentId?: string; task?: string }
          if (!task?.trim()) {
            res.writeHead(400).end(JSON.stringify({ success: false, message: 'task 必填' }))
            return
          }
          const result = await this.startInstance({
            agentId,
            task: String(task).slice(0, 4000),
            source: { scheduleId: 'webhook', scheduleName: 'Webhook' },
          })
          res.writeHead(result.success ? 200 : 400).end(JSON.stringify(result))
        } catch {
          res.writeHead(400).end(JSON.stringify({ success: false, message: '无效 JSON' }))
        }
      })()
    })
  }

  /** 追加消息到会话并推送渲染层 reload（否则渲染层 _persist 全量覆盖会丢数据） */
  private async appendConversationMessages(conversationId: string, messages: ChatMessage[]): Promise<void> {
    const conversations = await loadConversations()
    const conv = conversations.find((c) => c.id === conversationId)
    if (!conv) return
    conv.messages.push(...messages)
    conv.updatedAt = Date.now()
    await saveConversations(conversations)
    this.pushConversationUpdated()
  }
}

export const agentSystemStore = new AgentSystemStoreImpl()
