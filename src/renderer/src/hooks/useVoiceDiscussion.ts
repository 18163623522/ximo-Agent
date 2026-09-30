import { useState, useRef, useCallback, useEffect, useMemo } from 'react'
import { useStore } from '@renderer/store/useStore'
import { useStreamingTTS } from './useStreamingTTS'
import type { ApiMessage } from '@shared/types'
import { DEFAULT_DISCUSSION_MAX_TOKENS, type DiscussionState } from './useVoiceDiscussion/constants'
import { decodeToPCM } from './useVoiceDiscussion/audio'
import { createDiscussWithAI } from './useVoiceDiscussion/discuss'

// 对外符号与导入路径保持不变 — 实现拆分至 useVoiceDiscussion/ 子目录
export { DEFAULT_DISCUSSION_PROMPT, DEFAULT_DISCUSSION_MAX_TOKENS } from './useVoiceDiscussion/constants'
export type { DiscussionState } from './useVoiceDiscussion/constants'

/**
 * 语音讨论模式 — 回合制，讨论内容存本地实例，不污染主对话框。
 *
 * 流程：
 * 1. start() → 打开麦克风 → 自动开始录音 → state='listening'
 * 2. 用户点击麦克风 → 停止录音 → 转写 → discussWithAI() → state='speaking'
 * 3. AI 回复通过 window.api.chat.stream 直接流式获取 → TTS 朗读（不经过 store）
 * 4. TTS 朗读完毕 → 自动开始下一轮录音 → state='listening'
 * 5. stop() → 汇总所有讨论内容 → 改写为明确任务描述 → 一次性 sendMessage 到主对话框
 */
export function useVoiceDiscussion(): {
  isActive: boolean
  state: DiscussionState
  volume: number
  error: string | null
  isAIResponding: boolean
  start: () => Promise<void>
  stop: () => Promise<void>
  toggleRecording: () => void
} {
  const [isActive, setIsActive] = useState(false)
  const [state, setState] = useState<DiscussionState>('idle')
  const [error, setError] = useState<string | null>(null)
  const [isAIResponding, setIsAIResponding] = useState(false)

  const streamRef = useRef<MediaStream | null>(null)
  const recorderRef = useRef<MediaRecorder | null>(null)
  const chunksRef = useRef<Blob[]>([])
  const isActiveRef = useRef(false)
  const isAIRespondingRef = useRef(false)

  // 讨论消息 — 完全存本地，不进入 store 的 conversation
  const discussionMessagesRef = useRef<ApiMessage[]>([])

  const edgeTtsVoice = useStore((s) => s.settings?.edgeTtsVoice)
  const discussionPrompt = useStore((s) => s.settings?.voiceDiscussionPrompt)
  const autoContinue = useStore((s) => s.settings?.voiceDiscussionAutoContinue ?? true)
  const maxTokens = useStore((s) => s.settings?.voiceDiscussionMaxTokens) ?? DEFAULT_DISCUSSION_MAX_TOKENS
  const streamingTTS = useStreamingTTS(edgeTtsVoice)
  const ttsPush = streamingTTS.push
  const ttsFlush = streamingTTS.flush
  const ttsStop = streamingTTS.stop
  const ttsSpeakingRef = useRef(false)
  useEffect(() => { ttsSpeakingRef.current = streamingTTS.isSpeaking }, [streamingTTS.isSpeaking])

  // startRecording 用 ref 持有，避免循环依赖
  const startRecordingRef = useRef<() => void>(() => {})
  // 标记 AI 被用户手动打断，跳过自动重新录音
  const interruptedRef = useRef(false)

  /** 直接调用 AI 流式接口 — 绕过 store，讨论内容不进入主对话框（实现见 discuss.ts） */
  const discussWithAI = useMemo(
    () =>
      createDiscussWithAI({
        discussionMessagesRef,
        isActiveRef,
        isAIRespondingRef,
        interruptedRef,
        ttsSpeakingRef,
        startRecordingRef,
        setState,
        setIsAIResponding,
        setError,
        discussionPrompt,
        maxTokens,
        autoContinue,
        ttsPush,
        ttsFlush,
      }),
    // 依赖数组与拆分前（useCallback）保持一致
    [ttsPush, ttsFlush, autoContinue]
  )

  /** 处理录音结束后的音频 */
  const processAudio = useCallback(async (blob: Blob) => {
    if (blob.size < 500) {
      startRecordingRef.current()
      return
    }
    setState('transcribing')
    try {
      const pcm = await decodeToPCM(blob)
      const result = await window.api.voice.transcribe(pcm, 16000)
      if (result.error) {
        setError(result.error)
        startRecordingRef.current()
      } else if (result.text) {
        await discussWithAI(result.text)
      } else {
        startRecordingRef.current()
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      setError('语音识别失败: ' + msg)
      startRecordingRef.current()
    }
  }, [decodeToPCM, discussWithAI])

  /** 开始一轮新录音 */
  const startRecording = useCallback(() => {
    if (!isActiveRef.current) return
    const stream = streamRef.current
    if (!stream) return
    const old = recorderRef.current
    if (old && old.state !== 'inactive') {
      old.onstop = null
      old.stop()
    }
    chunksRef.current = []
    const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
      ? 'audio/webm;codecs=opus'
      : MediaRecorder.isTypeSupported('audio/webm')
        ? 'audio/webm'
        : ''
    const recorder = mimeType
      ? new MediaRecorder(stream, { mimeType })
      : new MediaRecorder(stream)
    recorder.ondataavailable = (e) => {
      if (e.data.size > 0) chunksRef.current.push(e.data)
    }
    recorder.onstop = () => {
      const audioBlob = new Blob(chunksRef.current, {
        type: recorder.mimeType || 'audio/webm',
      })
      chunksRef.current = []
      if (isActiveRef.current) void processAudio(audioBlob)
    }
    recorder.start()
    recorderRef.current = recorder
    setState('listening')
  }, [processAudio])

  useEffect(() => { startRecordingRef.current = startRecording }, [startRecording])

  /** 切换录音 — idle(待机)→开始录音 / listening→停止并发送 / speaking→打断AI并开始新录音 */
  const toggleRecording = useCallback(() => {
    if (state === 'idle') {
      // 关闭自动接续后的待机态：用户主动开始下一轮
      if (isActiveRef.current) startRecordingRef.current()
    } else if (state === 'listening') {
      const recorder = recorderRef.current
      if (recorder && recorder.state !== 'inactive') {
        recorder.stop()
        recorderRef.current = null
      }
    } else if (state === 'speaking') {
      // 用户手动打断 AI → 取消流 + 停止 TTS + 立即开始新录音
      interruptedRef.current = true
      void window.api.chat.cancel()
      ttsStop()
      ttsSpeakingRef.current = false
      isAIRespondingRef.current = false
      setIsAIResponding(false)
      startRecordingRef.current()
    }
  }, [state, ttsStop])

  /** 进入语音讨论模式 */
  const start = useCallback(async () => {
    // 权威校验：设置里关闭了就绝不启动（面板按钮已禁用，这里是第二道闸）
    if (useStore.getState().settings?.voiceDiscussionEnabled === false) {
      setError('语音讨论已在设置中关闭')
      return
    }
    setError(null)
    try {
      // 清理残留状态
      const store = useStore.getState()
      if (store.isStreaming) await store.cancelStream()
      ttsStop()
      ttsSpeakingRef.current = false
      discussionMessagesRef.current = []

      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      })
      streamRef.current = stream
      isActiveRef.current = true
      setIsActive(true)
      startRecording()
      stream.getTracks().forEach((t) => {
        t.onended = () => {
          if (isActiveRef.current) {
            setError('麦克风被系统关闭（可能被其他应用占用或系统隐私设置）')
          }
        }
      })
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      if (msg.includes('NotAllowed') || msg.includes('Permission')) {
        setError('麦克风权限被拒绝，请在系统设置中允许')
      } else {
        setError('启动语音讨论失败:B ' + msg)
      }
    }
  }, [startRecording, ttsStop])

  /** 结束讨论 → 汇总讨论内容 → 一次性发送到主对话框 */
  const stop = useCallback(async () => {
    isActiveRef.current = false
    setIsActive(false)
    setState('idle')
    setError(null)
    setIsAIResponding(false)
    isAIRespondingRef.current = false

    ttsStop()
    const recorder = recorderRef.current
    if (recorder && recorder.state !== 'inactive') {
      recorder.onstop = null
      recorder.stop()
      recorderRef.current = null
    }
    streamRef.current?.getTracks().forEach((t) => t.stop())
    streamRef.current = null

    // 取消可能正在进行的讨论流
    await window.api.chat.cancel()

    // 汇总讨论内容
    const messages = discussionMessagesRef.current
    discussionMessagesRef.current = []

    if (messages.length === 0) return

    // 将讨论内容格式化为一条明确的任务描述
    const discussionTranscript = messages
      .map((m) => m.role === 'user' ? `用户：${m.content}` : `AI：${m.content}`)
      .join('\n\n')

    const summaryPrompt = `以下是用户与AI通过语音讨论的完整内容：

${discussionTranscript}

---

请基于以上讨论，汇总并改写为明确的任务描述，然后直接开始实施。不需要再确认，直接执行。`

    // 一次性发送到主对话框
    const store = useStore.getState()
    if (store.isStreaming) await store.cancelStream()
    void store.sendMessage(summaryPrompt, { skipNetworkHint: true })
  }, [ttsStop])

  // 组件卸载时清理
  useEffect(() => {
    return () => {
      isActiveRef.current = false
      isAIRespondingRef.current = false
      ttsStop()
      const recorder = recorderRef.current
      if (recorder && recorder.state !== 'inactive') recorder.stop()
      streamRef.current?.getTracks().forEach((t) => t.stop())
      streamRef.current = null
    }
  }, [ttsStop])

  return { isActive, state, volume: 0, error, isAIResponding, start, stop, toggleRecording }
}
