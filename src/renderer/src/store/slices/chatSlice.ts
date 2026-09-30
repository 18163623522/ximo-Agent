import type { StateCreator } from 'zustand'
import type { ChatMessage } from '@shared/types'
import type { StoreState } from '@renderer/store/types'
import { runStream } from '../runStream'
import { cancelStream } from '../cancel-stream'
import { buildUserMessage } from '../buildUserMessage'
import { genId, makeTitle } from '../store-utils'
import { getActiveCustomProvider } from '@renderer/lib/providers'
import { buildHandoffTask } from '@renderer/lib/handoff'
import type { SetState } from '../stream-persist'

export type ChatSlice = Pick<StoreState,
  | 'sendMessage'
  | 'regenerate'
  | 'cancelStream'
>

export const createChatSlice: StateCreator<StoreState, [], [], ChatSlice> = (set, get) => ({
  sendMessage: async (text, options) => {
    const state = get()
    if (state.isStreaming) return
    if (!text.trim()) return

    // /handoff — 工作交接：当前对话打包为后台实例任务，AI 同事接手（不走聊天管线）
    if (options?.slashCommand?.cmd === '/handoff') {
      const conv = state.getCurrentConversation()
      if (!conv || conv.messages.length === 0) {
        set({ error: '当前会话没有可交接的内容' })
        return
      }
      const { task, messageCount } = buildHandoffTask(conv, text)
      try {
        const res = await window.api.agentSystem.startInstance({ task })
        if (res.success && res.instance) {
          const receipt: ChatMessage = {
            id: genId(),
            role: 'assistant',
            content: `🤝 已将本对话近期 ${messageCount} 条消息转交后台 Agent 接手（「${res.instance.agentName}」）。\n在左侧栏「Agent 系统 → 实例」可查看进度，完成后结果会写回会话「[${conv.title}]」。`,
            timestamp: Date.now()
          }
          set((s) => ({
            conversations: s.conversations.map((c) =>
              c.id === conv.id
                ? { ...c, messages: [...c.messages, receipt], updatedAt: Date.now() }
                : c
            )
          }))
          void get()._persist()
        } else {
          set({ error: res.message ?? '转交失败' })
        }
      } catch (e) {
        set({ error: (e as Error).message })
      }
      return
    }

    // 消息构建 — 联网搜索提示、附加文件、组件选择、@file 引用
    const { text: processedText, clearAttachedFiles, clearSelectedComponents } = await buildUserMessage({
      text,
      networkSearchOn: state.networkSearchOn,
      skipNetworkHint: options?.skipNetworkHint,
      attachedFiles: state.attachedFiles,
      selectedComponentIds: state.selectedComponentIds,
      currentMode: state.currentMode,
      projectPath: state.projectPath
    })
    const trimmed = processedText
    if (!trimmed) return
    if (clearAttachedFiles) get().clearAttachedFiles()
    if (clearSelectedComponents) get().clearSelectedComponents()

    // 确保有当前会话
    let conversationId = state.currentConversationId
    let conversation = state.getCurrentConversation()
    if (!conversation) {
      conversationId = get().newConversation()
      conversation = get().conversations.find((c) => c.id === conversationId) ?? null
    }
    if (!conversation || !conversationId) {
      return
    }

    const settings = state.settings
    if (!settings) return

    // 前端预检 API Key，避免空 Key 导致请求卡死 — 按活跃服务商检查（自定义服务商用自身 Key）
    const activeProvider = getActiveCustomProvider(settings)
    const activeApiKey = activeProvider ? activeProvider.apiKey : settings.apiKey
    if (!activeApiKey.trim()) {
      const tip = activeProvider
        ? `请先在设置中为服务商「${activeProvider.name}」配置 API Key 后再发送消息。`
        : '请先在设置中配置 API Key 后再发送消息。'
      set({ error: tip, isStreaming: false })
      return
    }

    const userMsg: ChatMessage = {
      id: genId(),
      role: 'user',
      content: trimmed,
      timestamp: Date.now(),
      ...(options?.slashCommand ? { slashCommand: options.slashCommand } : {})
    }

    const isFirst = conversation.messages.length === 0
    const assistantMsgId = genId()
    const placeholderMsg: ChatMessage = {
      id: assistantMsgId,
      role: 'assistant',
      content: '',
      timestamp: Date.now()
    }
    set((s) => ({
      conversations: s.conversations.map((c) =>
        c.id === conversationId
          ? {
              ...c,
              title: isFirst ? makeTitle(trimmed) : c.title,
              messages: [...c.messages, userMsg, placeholderMsg],
              updatedAt: Date.now()
            }
          : c
      ),
      isStreaming: true,
      streamingContent: '',
      streamingReasoning: '',
      streamingSegments: [{ reasoning: '', content: '', toolCalls: [] }],
      streamingConversationId: conversationId,
      streamingAssistantId: assistantMsgId,
      streamingTokens: null,
      streamingCacheHitTokens: null,
      streamingCacheMissTokens: null,
      streamingPromptTokens: null,
      streamingContextTokens: null,
      error: null
    }))

    await runStream(get as () => StoreState, set as SetState, conversationId)
  },

  regenerate: async () => {
    const state = get()
    if (state.isStreaming) return
    const conversation = state.getCurrentConversation()
    if (!conversation || conversation.messages.length === 0) return

    const msgs = [...conversation.messages]
    while (msgs.length > 0 && msgs[msgs.length - 1].role === 'assistant') {
      msgs.pop()
    }
    if (msgs.length === 0) return

    const assistantMsgId = genId()
    const placeholderMsg: ChatMessage = {
      id: assistantMsgId,
      role: 'assistant',
      content: '',
      timestamp: Date.now()
    }

    set((s) => ({
      conversations: s.conversations.map((c) =>
        c.id === conversation.id ? { ...c, messages: [...msgs, placeholderMsg], updatedAt: Date.now() } : c
      ),
      isStreaming: true,
      streamingContent: '',
      streamingReasoning: '',
      streamingSegments: [{ reasoning: '', content: '', toolCalls: [] }],
      streamingConversationId: conversation.id,
      streamingAssistantId: assistantMsgId,
      streamingTokens: null,
      streamingCacheHitTokens: null,
      streamingCacheMissTokens: null,
      streamingPromptTokens: null,
      streamingContextTokens: null,
      error: null
    }))

    await runStream(get as () => StoreState, set as SetState, conversation.id)
  },

  cancelStream: async () => { await cancelStream(get as () => StoreState, set as SetState) },
})
