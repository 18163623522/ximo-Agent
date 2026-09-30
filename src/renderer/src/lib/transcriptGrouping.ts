// ── 轮次分组 + 温区/冷区分页逻辑 ───────────────────────────────────────
// 参考 DeepSeek-Reasonix 的 transcriptGrouping.ts

import type { TranscriptItem, TurnGroup, QuestionAnchor, WarmLayerState, NoticeItem, AssistantItem } from './transcriptTypes'

// re-export 类型供外部使用
export type { TurnGroup, QuestionAnchor, WarmLayerState } from './transcriptTypes'

export const HOT_TURNS = 30
export const WARM_PAGE_SIZE = 20

export function createWarmLayerState(sessionKey: string): WarmLayerState {
  return { sessionKey, expandedWarmTurns: new Set(), coldPage: 0 }
}

export function warmLayerWithNextColdPage(state: WarmLayerState, sessionKey: string): WarmLayerState {
  const current = state.sessionKey === sessionKey ? state : createWarmLayerState(sessionKey)
  return { ...current, coldPage: current.coldPage + 1 }
}

export function warmLayerWithExpandedTurn(state: WarmLayerState, sessionKey: string, turn: number, expand: boolean): WarmLayerState {
  const current = state.sessionKey === sessionKey ? state : createWarmLayerState(sessionKey)
  const expandedWarmTurns = new Set(current.expandedWarmTurns)
  if (expand) expandedWarmTurns.add(turn)
  else expandedWarmTurns.delete(turn)
  return { ...current, expandedWarmTurns }
}

export function questionAnchorId(id: string): string {
  return `question-anchor-${id}`
}

export function compactQuestionText(text: string): string {
  const cleaned = text.replace(/\s+/g, ' ').trim()
  return cleaned.length <= 80 ? cleaned : cleaned.slice(0, 80)
}

export function warmUserPreview(text: string): string {
  const cleaned = text.replace(/\s+/g, ' ').trim()
  return cleaned.length <= 80 ? cleaned : cleaned.slice(0, 77) + '...'
}

/** 构建 questions 列表 */
export function buildQuestions(items: TranscriptItem[]): QuestionAnchor[] {
  const anchors: QuestionAnchor[] = []
  let turn = 0
  for (const it of items) {
    if (it.kind !== 'user') continue
    anchors.push({ id: it.id, text: compactQuestionText(it.text), turn })
    turn += 1
  }
  return anchors
}

/** 构建 user → turn 映射 */
export function questionTurnsById(questions: QuestionAnchor[]): Map<string, number> {
  const turns = new Map<string, number>()
  for (const q of questions) {
    turns.set(q.id, q.turn)
  }
  return turns
}

/** 最后一个 question 的 turn */
export function lastQuestionTurn(questions: readonly QuestionAnchor[]): number | undefined {
  if (questions.length === 0) return undefined
  return questions[questions.length - 1].turn
}

/** 把 items 按用户消息分成 TurnGroup */
export function buildTurnGroups(items: TranscriptItem[]): TurnGroup[] {
  const groups: TurnGroup[] = []
  let start = -1
  for (let i = 0; i < items.length; i++) {
    const item = items[i]
    if (item.kind === 'user') {
      if (start >= 0) {
        groups[groups.length - 1].endIdx = i
      }
      start = i
      groups.push({
        userItem: item,
        assistantPreview: '',
        toolCount: 0,
        startIdx: i,
        endIdx: items.length,
      })
    } else if (start >= 0 && groups.length > 0) {
      const group = groups[groups.length - 1]
      if (item.kind === 'assistant' && !item.streaming && item.text.trim()) {
        group.assistantPreview = warmUserPreview(item.text)
      }
      if (item.kind === 'tool') {
        group.toolCount += 1
      }
    }
  }
  return groups
}

/** 温区分页计算 */
export function warmPagination(params: {
  turnCount: number
  hotTurns: number
  pageSize: number
  coldPage: number
}): { warmStartTurn: number; warmEndTurn: number; coldTurnCount: number } {
  const { turnCount, hotTurns, pageSize, coldPage } = params
  const warmEndTurn = Math.max(0, turnCount - Math.min(turnCount, hotTurns))
  if (warmEndTurn === 0) return { warmStartTurn: 0, warmEndTurn: 0, coldTurnCount: 0 }

  const shownWarmCount = Math.min(warmEndTurn, pageSize * (coldPage + 1))
  return {
    warmStartTurn: warmEndTurn - shownWarmCount,
    warmEndTurn,
    coldTurnCount: warmEndTurn - shownWarmCount,
  }
}

/** 计算 hotStartIdx：热区在 items[] 中的起始索引 */
export function computeHotStartIdx(items: TranscriptItem[], hotTurns: number): number {
  let needed = hotTurns
  for (let i = items.length - 1; i >= 0; i--) {
    if (items[i].kind === 'user') {
      needed--
      if (needed <= 0) return i
    }
  }
  return 0
}

/** 用于 memo 的版本字符串 — 检测 items 结构变化 */
export function scrollVersion(items: TranscriptItem[]): string {
  return items
    .map((it) => {
      switch (it.kind) {
        case 'assistant': return `${it.id}:a:${it.streaming ? 1 : 0}`
        case 'tool': return `${it.id}:t:${it.status}`
        default: return `${it.id}:${it.kind}`
      }
    })
    .join('|')
}

// ── Turn 内部分区：过程材料 vs 对话回答 ──────────────────────────────────

export type TurnDisplayParts = {
  processItems: TranscriptItem[]
  outsideItems: Array<NoticeItem | AssistantItem>
}

type AnyItem = TranscriptItem

/**
 * 把一个 turn 内的 items 按频道拆分：
 * - processItems：推理 / 工具 / 阶段 / 通知 → 折叠
 * - outsideItems：回答正文 / 警告 → 不折叠
 */
export function partitionTurnItems(
  items: readonly AnyItem[],
  liveId?: string,
  liveHasAnswerText = false,
  liveHasReasoning = false,
): TurnDisplayParts[] {
  const segments: TurnDisplayParts[] = []
  let current: TurnDisplayParts = { processItems: [], outsideItems: [] }
  let currentHasConversation = false

  const flushSegment = () => {
    if (current.processItems.length === 0 && current.outsideItems.length === 0) return
    segments.push(current)
    current = { processItems: [], outsideItems: [] }
    currentHasConversation = false
  }

  const pushProcess = (item: AnyItem) => {
    if (currentHasConversation) flushSegment()
    current.processItems.push(item)
  }

  for (const item of items) {
    if (item.kind === 'user') continue
    if (item.kind === 'notice') {
      current.outsideItems.push(item)
      currentHasConversation = true
      continue
    }
    if (item.kind !== 'assistant') {
      pushProcess(item)
      continue
    }
    const hasReasoning = Boolean(item.reasoning || (liveId === item.id && liveHasReasoning))
    const hasAnswer = item.text.trim() !== '' || (liveId === item.id && liveHasAnswerText)

    if (hasAnswer) {
      if (hasReasoning) {
        // reasoning 作为过程材料。
        //
        // ⚠️ 副本必须剥离与 live 的 id 关联（id 改名），否则触发思考链重复渲染：
        // 流式中段（推理已出、正文开始输出）时，占位项 id === live.id 且
        // hasReasoning/hasAnswer 同时为 true → 此处 pushProcess 的副本保留原 id，
        // TurnCollapse 的 InlineReasoning 会因 `live.id === item.id` 注入
        // live.reasoning（**全量拼接串**），与事件流分片项（`-r` 后缀，各带分片）
        // 叠加 → 同一段思考渲染两遍。
        // 剥离后过程区只显示事件流分片（实时增量由分片承担，不丢实时性）；
        // liveTextOnly 标记在此副本上无意义，一并清掉。
        pushProcess({ ...item, text: '', id: `${item.id}-process`, liveTextOnly: undefined })
      }
      // text 作为回答
      current.outsideItems.push({ ...item, reasoning: '', reasoningComplete: true })
      currentHasConversation = true
      continue
    }
    if (hasReasoning) {
      pushProcess(item)
      continue
    }
    // 流式占位 item（无 reasoning 无 text）— 推入 outsideItems 显示加载动画
    if (liveId === item.id) {
      current.outsideItems.push(item)
      currentHasConversation = true
    }
  }
  flushSegment()
  return segments
}

// ── 辅助：提取 NoticeItem / AssistantItem 类型 ──────────────────────────

/** turn 工作时长计算 */
export function turnWorkDurationMs(items: readonly AnyItem[]): number {
  return items.reduce((ms, it) => {
    if (it.kind === 'assistant') return Math.max(ms, 0)
    if (it.kind === 'tool') return ms + (it.durationMs ?? 0)
    return ms
  }, 0)
}
