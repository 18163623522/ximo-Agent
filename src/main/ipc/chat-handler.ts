/**
 * 聊天相关 IPC 注册入口 — 按原有顺序编排各子注册器
 * （流式聊天 → 连接测试/模型列表 → 取消流 → 提示词增强）
 */

import { registerChatStreamHandlers } from './chat-stream-handlers'
import { registerChatProviderHandlers } from './chat-provider-handlers'
import { registerChatCancelHandlers } from './chat-cancel-handlers'
import { registerEnhancePromptHandler } from './enhance-prompt-handler'

export function registerChatHandlers(): void {
  // 流式聊天（chat:start + 会话取消状态）
  registerChatStreamHandlers()
  // 连接测试 + 自动获取模型列表（chat:test / providers:list-models）
  registerChatProviderHandlers()
  // 取消流式请求（chat:cancel）
  registerChatCancelHandlers()
  // 提示词增强（拆分到独立模块）
  registerEnhancePromptHandler()
}
