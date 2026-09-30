/**
 * gen-id — 短 ID 生成（前缀_时间戳_随机串），AgentSystem 各模块共用
 */
export const genId = (prefix: string): string =>
  `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
