/** 语音讨论 — AI 流式讨论与下一轮调度（自 useVoiceDiscussion.ts 拆出，依赖经上下文注入） */
import type { Dispatch, MutableRefObject, SetStateAction } from 'react'
import { useStore } from '@renderer/store/useStore'
import type { ApiMessage, ChatRequest, StreamChunk } from '@shared/types'
import { DEFAULT_DISCUSSION_PROMPT, type DiscussionState } from './constants'

/** discussWithAI 的依赖上下文 — 由 hook 注入 refs、setState 与配置 */
export interface DiscussContext {
  /** 讨论消息 — 完全存本地，不进入 store 的 conversation */
  discussionMessagesRef: MutableRefObject<ApiMessage[]>
  isActiveRef: MutableRefObject<boolean>
  isAIRespondingRef: MutableRefObject<boolean>
  /** 标记 AI 被用户手动打断，跳过自动重新录音 */
  interruptedRef: MutableRefObject<boolean>
  ttsSpeakingRef: MutableRefObject<boolean>
  startRecordingRef: MutableRefObject<() => void>
  setState: Dispatch<SetStateAction<DiscussionState>>
  setIsAIResponding: Dispatch<SetStateAction<boolean>>
  setError: Dispatch<SetStateAction<string | null>>
  discussionPrompt: string | undefined
  maxTokens: number
  autoContinue: boolean
  ttsPush: (text: string) => void
  ttsFlush: () => void
}

/** 直接调用 AI 流式接口 — 绕过 store，讨论内容不进入主对话框 */
export function createDiscussWithAI(ctx: DiscussContext): (userText: string) => Promise<void> {
  return async (userText: string) => {
    const store = useStore.getState()
    const settings = store.settings
    if (!settings) return

    // 追加用户消息到讨论历史
    ctx.discussionMessagesRef.current.push({ role: 'user', content: userText })

    // 构建请求 — 简洁讨论模式，无工具、无思维链（提示词/长度上限取自设置）
    const request: ChatRequest = {
      mode: store.currentMode,
      messages: [
        { role: 'system', content: ctx.discussionPrompt?.trim() || DEFAULT_DISCUSSION_PROMPT },
        ...ctx.discussionMessagesRef.current,
      ],
      model: settings.model,
      thinkingMode: false,
      reasoningEffort: 'off',
      temperature: settings.temperature,
      maxTokens: ctx.maxTokens,
      sessionId: 'voice-discussion',
      providerId: settings.activeProviderId ?? 'deepseek',
    }

    ctx.isAIRespondingRef.current = true
    ctx.setIsAIResponding(true)
    ctx.setState('speaking')

    let fullResponse = ''
    try {
      await window.api.chat.stream(request, (chunk: StreamChunk) => {
        if (chunk.content) {
          fullResponse += chunk.content
          ctx.ttsPush(chunk.content)
        }
        if (chunk.error) {
          ctx.setError(chunk.error)
        }
      })
    } catch {
      // 流式异常 — 不中断讨论，继续下一轮
    }

    // 追加 AI 回复到讨论历史
    if (fullResponse.trim()) {
      ctx.discussionMessagesRef.current.push({ role: 'assistant', content: fullResponse })
    }

    ctx.isAIRespondingRef.current = false
    ctx.setIsAIResponding(false)

    if (!ctx.interruptedRef.current) {
      // 正常结束 → 等 TTS 朗读完毕
      // 需要连续 3 次（600ms）检测到非播放状态才确认 TTS 真正结束，避免 isSpeaking 异步更新导致的竞态
      ctx.ttsFlush()
      if (!ctx.autoContinue) {
        // 自动接续已关闭 → 朗读结束回到待机，由用户点击麦克风开始下一轮
        const wait = setInterval(() => {
          if (!ctx.ttsSpeakingRef.current) {
            clearInterval(wait)
            if (ctx.isActiveRef.current) ctx.setState('idle')
          }
        }, 200)
        setTimeout(() => clearInterval(wait), 30000)
      } else {
        let stableCount = 0
        const check = setInterval(() => {
          if (!ctx.ttsSpeakingRef.current) {
            stableCount++
            if (stableCount >= 3) {
              clearInterval(check)
              if (ctx.isActiveRef.current) ctx.startRecordingRef.current()
            }
          } else {
            stableCount = 0
          }
        }, 200)
        setTimeout(() => clearInterval(check), 30000)
      }
    } else {
      // 用户已手动打断 → 跳过自动重新录音
      ctx.interruptedRef.current = false
    }
  }
}
