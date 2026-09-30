// ── ChatMessage → TranscriptItem 适配器 ─────────────────────────────────
// 把我们的嵌套 ChatMessage[] (toolCalls/toolResults 挂在消息上)
// 转成 DeepSeek-Reasonix 风格的扁平 Item[] (每个工具/通知是独立条目)
//
// 实现按职责拆分在同目录 transcriptAdapter/ 子文件夹，此处保留原路径导出。

export { toolLabel } from './transcriptAdapter/toolMeta'
export { adaptMessages } from './transcriptAdapter/adaptMessages'
export { buildLiveStream } from './transcriptAdapter/liveStream'
