/**
 * UI 测试 — 渲染进程组件渲染与交互逻辑
 *
 * 由于项目未配置 jsdom + @testing-library/react，这里测试
 * 渲染进程的纯逻辑函数（非 JSX 渲染），包括：
 * - 转录分组逻辑
 * - Auto Mode 选项
 * - Store 工具函数
 * - 样式/主题相关逻辑
 *
 * 这些逻辑是 UI 渲染的核心驱动，测试它们确保 UI 行为正确。
 */
import { describe, it, expect } from 'vitest'
import {
  buildTurnGroups,
  buildQuestions,
  compactQuestionText,
  warmUserPreview,
  warmPagination,
  computeHotStartIdx,
  scrollVersion,
  questionAnchorId,
  createWarmLayerState,
  warmLayerWithNextColdPage,
  warmLayerWithExpandedTurn,
  questionTurnsById,
  lastQuestionTurn,
  turnWorkDurationMs,
  partitionTurnItems
} from '../../src/renderer/src/lib/transcriptGrouping'
import type { TranscriptItem } from '../../src/renderer/src/lib/transcriptTypes'
import {
  AUTO_MODE_OPTIONS,
  normalizeAutoMode,
  autoModeOption,
  AUTO_MODE_DEFAULT,
  AUTO_MODE_TRIGGER_TONE
} from '../../src/renderer/src/lib/auto-mode'
import { makeTitle } from '../../src/renderer/src/store/utils'
import { DEFAULT_SETTINGS } from '../../src/shared/defaults'

// ── 辅助 ─────────────────────────────────────────────────

function item(kind: string, id: string, extra: Record<string, unknown> = {}): TranscriptItem {
  return { kind, id, ...extra } as unknown as TranscriptItem
}

// ── 1. Auto Mode UI 逻辑 ─────────────────────────────────

describe('[UI] Auto Mode 选项', () => {
  it('三个选项有正确的 tone', () => {
    const off = AUTO_MODE_OPTIONS.find(o => o.value === 'off')!
    const safe = AUTO_MODE_OPTIONS.find(o => o.value === 'safe')!
    const yolo = AUTO_MODE_OPTIONS.find(o => o.value === 'yolo')!

    expect(off.tone).toBe('neutral')
    expect(safe.tone).toBe('accent')
    expect(yolo.tone).toBe('danger')
  })

  it('每个选项有 short 标签', () => {
    for (const opt of AUTO_MODE_OPTIONS) {
      expect(opt.short).toBeTruthy()
      expect(opt.short.length).toBeLessThanOrEqual(2)
    }
  })

  it('AUTO_MODE_DEFAULT 是 off', () => {
    expect(AUTO_MODE_DEFAULT).toBe('off')
  })

  it('autoModeOption 返回正确选项', () => {
    expect(autoModeOption('off').value).toBe('off')
    expect(autoModeOption('safe').value).toBe('safe')
    expect(autoModeOption('yolo').value).toBe('yolo')
  })

  it('autoModeOption 非法值返回默认', () => {
    expect(autoModeOption('invalid').value).toBe('off')
    expect(autoModeOption(null).value).toBe('off')
  })

  it('AUTO_MODE_TRIGGER_TONE 有三种 tone', () => {
    expect(Object.keys(AUTO_MODE_TRIGGER_TONE)).toHaveLength(3)
    expect(AUTO_MODE_TRIGGER_TONE.neutral).toBeDefined()
    expect(AUTO_MODE_TRIGGER_TONE.accent).toBeDefined()
    expect(AUTO_MODE_TRIGGER_TONE.danger).toBeDefined()
  })
})

// ── 2. 转录分组 — TurnGroup 构建 ─────────────────────────

describe('[UI] buildTurnGroups', () => {
  it('单个用户消息产生 1 组', () => {
    const items = [item('user', 'u1', { text: 'hello' })]
    const groups = buildTurnGroups(items)
    expect(groups).toHaveLength(1)
    expect(groups[0].userItem.id).toBe('u1')
  })

  it('assistant preview 在非流式时填充', () => {
    const items = [
      item('user', 'u1', { text: 'q' }),
      item('assistant', 'a1', { text: 'answer text', streaming: false }),
    ]
    const groups = buildTurnGroups(items)
    expect(groups[0].assistantPreview).toBe('answer text')
  })

  it('流式中的 assistant 不填充 preview', () => {
    const items = [
      item('user', 'u1', { text: 'q' }),
      item('assistant', 'a1', { text: 'partial', streaming: true }),
    ]
    const groups = buildTurnGroups(items)
    expect(groups[0].assistantPreview).toBe('')
  })

  it('工具调用计入 toolCount', () => {
    const items = [
      item('user', 'u1', { text: 'q' }),
      item('tool', 't1', { status: 'done' }),
      item('tool', 't2', { status: 'calling' }),
    ]
    const groups = buildTurnGroups(items)
    expect(groups[0].toolCount).toBe(2)
  })

  it('endIdx 正确设置', () => {
    const items = [
      item('user', 'u1', { text: 'q1' }),
      item('assistant', 'a1', { text: 'a1', streaming: false }),
      item('user', 'u2', { text: 'q2' }),
      item('assistant', 'a2', { text: 'a2', streaming: false }),
    ]
    const groups = buildTurnGroups(items)
    expect(groups[0].endIdx).toBe(2) // u2 的索引
    expect(groups[1].endIdx).toBe(4) // items.length
  })
})

// ── 3. 转录分组 — Questions ──────────────────────────────

describe('[UI] buildQuestions', () => {
  it('按用户消息构建 questions 列表', () => {
    const items = [
      item('user', 'u1', { text: 'first question' }),
      item('assistant', 'a1', { text: 'answer', streaming: false }),
      item('user', 'u2', { text: 'second question' }),
    ]
    const questions = buildQuestions(items)
    expect(questions).toHaveLength(2)
    expect(questions[0].turn).toBe(0)
    expect(questions[1].turn).toBe(1)
  })

  it('无用户消息时返回空数组', () => {
    expect(buildQuestions([])).toEqual([])
    expect(buildQuestions([item('assistant', 'a1', { text: 'x', streaming: false })])).toEqual([])
  })
})

describe('[UI] questionAnchorId', () => {
  it('格式为 question-anchor-{id}', () => {
    expect(questionAnchorId('abc')).toBe('question-anchor-abc')
  })
})

describe('[UI] questionTurnsById / lastQuestionTurn', () => {
  it('构建 id → turn 映射', () => {
    const questions = [
      { id: 'u1', text: 'q1', turn: 0 },
      { id: 'u2', text: 'q2', turn: 1 }
    ]
    const map = questionTurnsById(questions)
    expect(map.get('u1')).toBe(0)
    expect(map.get('u2')).toBe(1)
  })

  it('lastQuestionTurn 返回最后一个 turn', () => {
    const questions = [
      { id: 'u1', text: '', turn: 0 },
      { id: 'u2', text: '', turn: 1 },
      { id: 'u3', text: '', turn: 2 }
    ]
    expect(lastQuestionTurn(questions)).toBe(2)
  })

  it('空数组返回 undefined', () => {
    expect(lastQuestionTurn([])).toBeUndefined()
  })
})

// ── 4. 转录分组 — 温区分页 ───────────────────────────────

describe('[UI] WarmLayer 状态管理', () => {
  it('createWarmLayerState 初始值', () => {
    const state = createWarmLayerState('session-1')
    expect(state.sessionKey).toBe('session-1')
    expect(state.expandedWarmTurns.size).toBe(0)
    expect(state.coldPage).toBe(0)
  })

  it('warmLayerWithNextColdPage 递增 coldPage', () => {
    const state = createWarmLayerState('s1')
    const next = warmLayerWithNextColdPage(state, 's1')
    expect(next.coldPage).toBe(1)
    const next2 = warmLayerWithNextColdPage(next, 's1')
    expect(next2.coldPage).toBe(2)
  })

  it('warmLayerWithExpandedTurn 添加/移除 turn', () => {
    const state = createWarmLayerState('s1')
    const expanded = warmLayerWithExpandedTurn(state, 's1', 5, true)
    expect(expanded.expandedWarmTurns.has(5)).toBe(true)
    const collapsed = warmLayerWithExpandedTurn(expanded, 's1', 5, false)
    expect(collapsed.expandedWarmTurns.has(5)).toBe(false)
  })

  it('sessionKey 切换时重置状态', () => {
    const state = createWarmLayerState('s1')
    state.coldPage = 5
    state.expandedWarmTurns.add(10)

    const next = warmLayerWithNextColdPage(state, 's2')
    expect(next.sessionKey).toBe('s2')
    expect(next.coldPage).toBe(1)
    expect(next.expandedWarmTurns.size).toBe(0)
  })
})

// ── 5. 转录分组 — computeHotStartIdx ─────────────────────

describe('[UI] computeHotStartIdx', () => {
  it('items 数量少于 hotTurns 时从 0 开始', () => {
    const items = [
      item('user', 'u1'),
      item('assistant', 'a1'),
    ]
    expect(computeHotStartIdx(items, 30)).toBe(0)
  })

  it('正确计算热区起始索引', () => {
    const items: TranscriptItem[] = []
    for (let i = 0; i < 5; i++) {
      items.push(item('user', `u${i}`, { text: `q${i}` }))
      items.push(item('assistant', `a${i}`, { text: `a${i}`, streaming: false }))
    }
    // 5 轮，hotTurns=2 → 从第 4 轮的用户消息开始
    const idx = computeHotStartIdx(items, 2)
    expect(idx).toBeGreaterThan(0)
    expect(items[idx].kind).toBe('user')
  })
})

// ── 6. 转录分组 — scrollVersion ──────────────────────────

describe('[UI] scrollVersion', () => {
  it('streaming 状态变化改变版本', () => {
    const items1 = [item('assistant', 'a1', { text: 'hi', streaming: true })]
    const items2 = [item('assistant', 'a1', { text: 'hi', streaming: false })]
    expect(scrollVersion(items1)).not.toBe(scrollVersion(items2))
  })

  it('tool status 变化改变版本', () => {
    const items1 = [item('tool', 't1', { status: 'calling' })]
    const items2 = [item('tool', 't1', { status: 'done' })]
    expect(scrollVersion(items1)).not.toBe(scrollVersion(items2))
  })
})

// ── 7. 转录分组 — turnWorkDurationMs ─────────────────────

describe('[UI] turnWorkDurationMs', () => {
  it('累加 tool 的 durationMs', () => {
    const items = [
      item('tool', 't1', { durationMs: 1000 }),
      item('tool', 't2', { durationMs: 2000 }),
      item('assistant', 'a1', { text: '', streaming: false }),
    ]
    expect(turnWorkDurationMs(items)).toBe(3000)
  })

  it('无 tool 时返回 0', () => {
    const items = [item('assistant', 'a1', { text: 'hi', streaming: false })]
    expect(turnWorkDurationMs(items)).toBe(0)
  })

  it('无 durationMs 的 tool 不计入', () => {
    const items = [item('tool', 't1', {})]
    expect(turnWorkDurationMs(items)).toBe(0)
  })
})

// ── 8. 转录分组 — partitionTurnItems ─────────────────────

describe('[UI] partitionTurnItems', () => {
  it('把 user 消息跳过', () => {
    const items = [
      item('user', 'u1', { text: 'q' }),
      item('assistant', 'a1', { text: 'answer', streaming: false }),
    ]
    const segments = partitionTurnItems(items)
    // user 被跳过
    const allItems = segments.flatMap(s => [...s.processItems, ...s.outsideItems])
    expect(allItems.every(i => i.kind !== 'user')).toBe(true)
  })

  it('有 text 的 assistant 进入 outsideItems', () => {
    const items = [
      item('assistant', 'a1', { text: 'answer text', streaming: false }),
    ]
    const segments = partitionTurnItems(items)
    expect(segments).toHaveLength(1)
    expect(segments[0].outsideItems).toHaveLength(1)
  })

  it('有 reasoning 的 assistant 进入 processItems', () => {
    const items = [
      item('assistant', 'a1', { reasoning: 'thinking...', text: '', streaming: false }),
    ]
    const segments = partitionTurnItems(items)
    expect(segments[0].processItems.length).toBeGreaterThan(0)
  })

  it('tool 始终进入 processItems', () => {
    const items = [
      item('tool', 't1', { status: 'done' }),
    ]
    const segments = partitionTurnItems(items)
    expect(segments[0].processItems).toHaveLength(1)
  })
})

// ── 9. DEFAULT_SETTINGS UI 相关字段 ──────────────────────

describe('[UI] DEFAULT_SETTINGS UI 字段', () => {
  it('有合法的 themeColor', () => {
    expect(DEFAULT_SETTINGS.themeColor).toMatch(/^#[0-9a-f]{6}$/i)
  })

  it('theme 是 dark 或 light', () => {
    expect(['dark', 'light']).toContain(DEFAULT_SETTINGS.theme)
  })

  it('fontSize 是 sm/md/lg', () => {
    expect(['sm', 'md', 'lg']).toContain(DEFAULT_SETTINGS.fontSize)
  })

  it('startupAnimationEnabled 默认 true', () => {
    expect(DEFAULT_SETTINGS.startupAnimationEnabled).toBe(true)
  })

  it('cursorEffectsEnabled 默认 false', () => {
    expect(DEFAULT_SETTINGS.cursorEffectsEnabled).toBe(false)
  })

  it('backgroundImage 默认 none', () => {
    expect(DEFAULT_SETTINGS.backgroundImage.type).toBe('none')
  })
})

// ── 10. makeTitle UI 逻辑 ────────────────────────────────

describe('[UI] makeTitle 截断', () => {
  it('正好 24 字符不加省略号', () => {
    expect(makeTitle('a'.repeat(24))).toBe('a'.repeat(24))
  })

  it('25 字符加省略号', () => {
    expect(makeTitle('a'.repeat(25))).toBe('a'.repeat(24) + '…')
  })

  it('中文文本正常处理', () => {
    expect(makeTitle('你好世界')).toBe('你好世界')
  })

  it('超长中文文本截断', () => {
    const long = '你好'.repeat(20)
    const result = makeTitle(long)
    expect(result.length).toBeLessThanOrEqual(25)
    expect(result).toContain('…')
  })
})
