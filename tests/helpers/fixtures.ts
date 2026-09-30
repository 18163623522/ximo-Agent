/**
 * 测试 fixtures — 构造最小可用的类型化 mock 对象
 */
import type {
  AppSettings,
  Conversation,
  ChatMessage,
  ChatRequest,
  ToolDefinition,
  ToolCall,
  ToolResult,
  Mode
} from '../../src/shared/types'

export function makeSettings(overrides: Partial<AppSettings> = {}): AppSettings {
  return {
    apiKey: 'test-key',
    baseUrl: 'https://api.deepseek.com/v1',
    model: 'deepseek-v4-pro',
    thinkingMode: true,
    reasoningEffort: 'high',
    temperature: 0.7,
    maxTokens: 8192,
    fontSize: 'md',
    customPrompt: '',
    themeColor: '#6366f1',
    theme: 'dark',
    ...overrides
  }
}

export function makeMessage(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: 'msg-1',
    role: 'user',
    content: 'hello',
    timestamp: Date.now(),
    ...overrides
  }
}

export function makeConversation(overrides: Partial<Conversation> = {}): Conversation {
  return {
    id: 'conv-1',
    title: 'Test',
    mode: 'office' as Mode,
    messages: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides
  }
}

export function makeChatRequest(overrides: Partial<ChatRequest> = {}): ChatRequest {
  return {
    mode: 'coding',
    messages: [{ role: 'user', content: 'test' }],
    model: 'deepseek-v4-pro',
    thinkingMode: true,
    reasoningEffort: 'high',
    temperature: 0.7,
    maxTokens: 8192,
    ...overrides
  }
}

export function makeToolCall(overrides: Partial<ToolCall> = {}): ToolCall {
  return {
    id: 'tc-1',
    name: 'file_read',
    arguments: { filePath: '/tmp/test.txt' },
    ...overrides
  }
}

export function makeToolResult(overrides: Partial<ToolResult> = {}): ToolResult {
  return {
    toolCallId: 'tc-1',
    toolName: 'file_read',
    content: 'file content',
    success: true,
    ...overrides
  }
}

export function makeToolDefinition(overrides: Partial<ToolDefinition> = {}): ToolDefinition {
  return {
    name: 'file_read',
    description: 'Read a file',
    parameters: {
      type: 'object',
      properties: {
        filePath: { type: 'string', description: 'Path to file' }
      },
      required: ['filePath']
    },
    ...overrides
  }
}

/** 生成 N 个 tool definitions（用于排序测试） */
export function makeToolDefinitions(names: string[]): ToolDefinition[] {
  return names.map((name) => makeToolDefinition({ name, description: `Tool ${name}` }))
}
