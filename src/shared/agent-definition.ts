// ====== Agent 定义与实例 — 主进程（引擎/持久化）与渲染进程（面板）共用 ======

/** Agent 定义 = 一个可复用的后台执行角色（独立于三模式体系，使用完整通用工具集） */
export interface AgentDefinition {
  id: string
  name: string
  /** 头像 emoji */
  emoji: string
  /** 一句话定位 */
  description: string
  /** 附加职责指令（拼进实例系统提示词） */
  systemPrompt: string
  /** 在隔离桌面中执行 */
  useDesktop: boolean
  /** 后台免审批（yolo）— 关闭时需要确认的操作 fail-closed 拒绝并记录 */
  autoApprove: boolean
}

/** 实例 = 一次后台执行（持久化，保留最近 50 条） */
export interface AgentInstance {
  id: string
  agentId: string
  agentName: string
  task: string
  /** 结果写入的会话 */
  conversationId: string
  /** queued = 桌面互斥队列中等待前一个完成 */
  status: 'queued' | 'running' | 'completed' | 'error'
  startedAt: number
  finishedAt?: number
  /** 最终回复预览 */
  resultPreview?: string
  error?: string
  /** 本次执行的 token 用量 */
  tokens?: { prompt: number; completion: number; total: number }
  /** 当前正在执行的动作（实时活动流，非持久化关键数据） */
  activity?: string
  source?: { scheduleId: string; scheduleName: string }
}

/** 内置默认 Agent 定义 id */
export const DEFAULT_AGENT_ID = 'agent_default_assistant'

/** 种子定义 — 首次加载且定义库为空时自动补齐 */
export function seedDefinitions(): AgentDefinition[] {
  return [
    {
      id: DEFAULT_AGENT_ID,
      name: '通用助手',
      emoji: '🤖',
      description: '通用后台执行 Agent，处理日常任务',
      systemPrompt: '认真完成任务，结果汇报结构清晰、重点突出。',
      useDesktop: false,
      autoApprove: false,
    },
  ]
}
