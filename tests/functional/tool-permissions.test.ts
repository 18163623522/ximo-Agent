/**
 * 功能测试 — 工具权限系统 (tool-permissions.ts)
 *
 * 测试权限评估、拒绝缓存、会话内拒绝持久化。
 */
import { describe, it, expect, beforeEach } from 'vitest'
import {
  clearRejectedCache,
  isPreviouslyRejected,
  rememberRejected,
  checkPermissions
} from '../../src/main/deepseek/tool-permissions'
import type { ChatRequest, ToolCall } from '../../src/shared/types'
import type { MutableMessage } from '../../src/shared/cache'

function makeHandlers(autoModeLevel: 'off' | 'safe' | 'yolo' = 'off') {
  const chunks: unknown[] = []
  return {
    chunks,
    handlers: {
      autoModeLevel,
      yoloMode: autoModeLevel === 'yolo',
      onChunk: (chunk: unknown) => chunks.push(chunk),
      requestConfirmation: async () => true // 默认同意
    }
  }
}

function makeToolCall(name: string, args: Record<string, unknown> = {}, id = 'tc-1'): ToolCall {
  return { id, name, arguments: args }
}

describe('[功能] 拒绝缓存', () => {
  beforeEach(() => {
    clearRejectedCache()
  })

  it('记住拒绝后 isPreviouslyRejected 返回 true', () => {
    rememberRejected('terminal_exec', { command: 'rm -rf /' })
    expect(isPreviouslyRejected('terminal_exec', { command: 'rm -rf /' })).toBe(true)
  })

  it('不同参数不共享拒绝', () => {
    rememberRejected('terminal_exec', { command: 'rm -rf /' })
    expect(isPreviouslyRejected('terminal_exec', { command: 'ls' })).toBe(false)
  })

  it('clearRejectedCache 清空所有记忆', () => {
    rememberRejected('file_delete', { filePath: '/tmp' })
    clearRejectedCache()
    expect(isPreviouslyRejected('file_delete', { filePath: '/tmp' })).toBe(false)
  })
})

describe('[功能] checkPermissions — YOLO 模式', () => {
  it('YOLO 模式下所有工具都 allow', async () => {
    const { handlers, chunks } = makeHandlers('yolo')
    const request: ChatRequest = {
      mode: 'coding',
      messages: [],
      model: 'deepseek-v4-pro',
      thinkingMode: true,
      reasoningEffort: 'high',
      temperature: 0.7,
      maxTokens: 8192
    }
    const messages: MutableMessage[] = []
    const toolCalls = [makeToolCall('terminal_exec', { command: 'rm -rf /' })]

    const cancelled = await checkPermissions(toolCalls, request, handlers, messages)

    expect(cancelled.size).toBe(0)
    expect(chunks).toHaveLength(0) // 无拒绝 → 无 chunk
  })
})

describe('[功能] checkPermissions — Coding 模式', () => {
  it('allow 工具不取消', async () => {
    const { handlers } = makeHandlers('off')
    const request: ChatRequest = {
      mode: 'coding',
      messages: [],
      model: 'deepseek-v4-pro',
      thinkingMode: true,
      reasoningEffort: 'high',
      temperature: 0.7,
      maxTokens: 8192
    }
    const toolCalls = [makeToolCall('file_read', { filePath: '/tmp/test' })]
    const cancelled = await checkPermissions(toolCalls, request, handlers, [])
    expect(cancelled.size).toBe(0)
  })

  it('deny 工具被取消', async () => {
    const { handlers, chunks } = makeHandlers('off')
    const request: ChatRequest = {
      mode: 'coding',
      messages: [],
      model: 'deepseek-v4-pro',
      thinkingMode: true,
      reasoningEffort: 'high',
      temperature: 0.7,
      maxTokens: 8192
    }
    const toolCalls = [makeToolCall('act_ui', {})]
    const messages: MutableMessage[] = []
    const cancelled = await checkPermissions(toolCalls, request, handlers, messages)

    expect(cancelled.size).toBe(1)
    expect(cancelled.has('tc-1')).toBe(true)
    expect(chunks).toHaveLength(1)
    expect(messages).toHaveLength(1) // 添加了 error 消息
  })

  it('ask 工具用户同意后不取消', async () => {
    const { handlers } = makeHandlers('off')
    const request: ChatRequest = {
      mode: 'coding',
      messages: [],
      model: 'deepseek-v4-pro',
      thinkingMode: true,
      reasoningEffort: 'high',
      temperature: 0.7,
      maxTokens: 8192
    }
    const toolCalls = [makeToolCall('terminal_exec', { command: 'ls' })]
    const cancelled = await checkPermissions(toolCalls, request, handlers, [])
    expect(cancelled.size).toBe(0)
  })

  it('ask 工具用户拒绝后取消', async () => {
    const { chunks } = makeHandlers('off')
    const handlers = {
      autoModeLevel: 'off' as const,
      yoloMode: false,
      onChunk: (chunk: unknown) => chunks.push(chunk),
      requestConfirmation: async () => false // 用户拒绝
    }
    const request: ChatRequest = {
      mode: 'coding',
      messages: [],
      model: 'deepseek-v4-pro',
      thinkingMode: true,
      reasoningEffort: 'high',
      temperature: 0.7,
      maxTokens: 8192
    }
    const toolCalls = [makeToolCall('terminal_exec', { command: 'rm -rf /' })]
    const messages: MutableMessage[] = []
    const cancelled = await checkPermissions(toolCalls, request, handlers, messages)

    expect(cancelled.size).toBe(1)
    expect(chunks).toHaveLength(1)
    expect(messages).toHaveLength(1)
  })

  it('拒绝后同会话不再弹窗', async () => {
    clearRejectedCache()
    const confirmCalls: boolean[] = []
    const chunks: unknown[] = []
    const handlers = {
      autoModeLevel: 'off' as const,
      yoloMode: false,
      onChunk: (chunk: unknown) => chunks.push(chunk),
      requestConfirmation: async () => {
        confirmCalls.push(false)
        return false
      }
    }
    const request: ChatRequest = {
      mode: 'coding',
      messages: [],
      model: 'deepseek-v4-pro',
      thinkingMode: true,
      reasoningEffort: 'high',
      temperature: 0.7,
      maxTokens: 8192
    }
    const tc1 = makeToolCall('terminal_exec', { command: 'rm -rf /' }, 'tc-1')
    const tc2 = makeToolCall('terminal_exec', { command: 'rm -rf /' }, 'tc-2')

    await checkPermissions([tc1], request, handlers, [])
    await checkPermissions([tc2], request, handlers, [])

    // 第二次不应再调用 requestConfirmation
    expect(confirmCalls).toHaveLength(1)
  })
})

describe('[功能] checkPermissions — 无 confirmCallback', () => {
  it('ask 工具无 confirmCallback 时 fail-closed', async () => {
    const chunks: unknown[] = []
    const handlers = {
      autoModeLevel: 'off' as const,
      yoloMode: false,
      onChunk: (chunk: unknown) => chunks.push(chunk)
      // 无 requestConfirmation
    }
    const request: ChatRequest = {
      mode: 'coding',
      messages: [],
      model: 'deepseek-v4-pro',
      thinkingMode: true,
      reasoningEffort: 'high',
      temperature: 0.7,
      maxTokens: 8192
    }
    const toolCalls = [makeToolCall('terminal_exec', { command: 'ls' })]
    const cancelled = await checkPermissions(toolCalls, request, handlers, [])
    expect(cancelled.size).toBe(1)
  })
})
