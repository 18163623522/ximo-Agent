/**
 * 功能测试 — Store 工具函数、会话存储、转录分组
 */
import { describe, it, expect } from 'vitest'
import { genId } from '../../src/shared/utils'
import { makeTitle } from '../../src/renderer/src/store/utils'
import { normalizeToolSchemas } from '../../src/shared/cache/tool-normalize'
import { normaliseUsage } from '../../src/shared/cache/normalize-usage'
import { normalizeAutoMode, AUTO_MODE_OPTIONS } from '../../src/renderer/src/lib/auto-mode'
import {
  buildTurnGroups,
  buildQuestions,
  compactQuestionText,
  warmUserPreview,
  warmPagination,
  computeHotStartIdx,
  scrollVersion
} from '../../src/renderer/src/lib/transcriptGrouping'
import type { TranscriptItem } from '../../src/renderer/src/lib/transcriptTypes'
import { normalizeModelId, getModelLabel, getModelShortLabel } from '../../src/shared/models'

describe('[功能] genId 唯一性', () => {
  it('生成 10000 个不重复 ID', () => {
    const ids = new Set<string>()
    for (let i = 0; i < 10000; i++) ids.add(genId())
    expect(ids.size).toBe(10000)
  })

  it('ID 长度在合理范围', () => {
    const id = genId()
    expect(id.length).toBeGreaterThanOrEqual(8)
    expect(id.length).toBeLessThanOrEqual(30)
  })
})

describe('[功能] makeTitle 会话标题', () => {
  it('短文本原样返回', () => {
    expect(makeTitle('hello')).toBe('hello')
  })

  it('长文本截断并加省略号', () => {
    const long = 'a'.repeat(30)
    expect(makeTitle(long)).toHaveLength(25) // 24 + '…'
    expect(makeTitle(long)).toContain('…')
  })

  it('空字符串返回"新对话"', () => {
    expect(makeTitle('')).toBe('新对话')
    expect(makeTitle('   ')).toBe('新对话')
  })

  it('多空白字符合并为单个空格', () => {
    expect(makeTitle('hello    world')).toBe('hello world')
  })
})

describe('[功能] normalizeToolSchemas — 排序稳定性', () => {
  it('相同输入产生相同输出（缓存友好）', () => {
    const tools = [
      { name: 'c_tool', description: 'C', parameters: { type: 'object' as const, properties: {} } },
      { name: 'a_tool', description: 'A', parameters: { type: 'object' as const, properties: {} } },
      { name: 'b_tool', description: 'B', parameters: { type: 'object' as const, properties: {} } }
    ]
    const r1 = normalizeToolSchemas(tools)
    const r2 = normalizeToolSchemas(tools)
    expect(JSON.stringify(r1)).toBe(JSON.stringify(r2))
  })

  it('不影响原数组', () => {
    const tools = [
      { name: 'b', description: 'B', parameters: { type: 'object' as const, properties: {} } },
      { name: 'a', description: 'A', parameters: { type: 'object' as const, properties: {} } }
    ]
    const original = [...tools]
    normalizeToolSchemas(tools)
    expect(tools.map(t => t.name)).toEqual(original.map(t => t.name))
  })
})

describe('[功能] normaliseUsage — token 用量归一化', () => {
  it('DeepSeek 格式：顶层 cache hit/miss', () => {
    const result = normaliseUsage({
      prompt_tokens: 1000,
      completion_tokens: 500,
      total_tokens: 1500,
      prompt_cache_hit_tokens: 800,
      prompt_cache_miss_tokens: 200
    })
    expect(result.promptTokens).toBe(1000)
    expect(result.completionTokens).toBe(500)
    expect(result.cacheHitTokens).toBe(800)
    expect(result.cacheMissTokens).toBe(200)
  })

  it('OpenAI 格式：嵌套 cached_tokens', () => {
    const result = normaliseUsage({
      prompt_tokens: 1000,
      completion_tokens: 500,
      total_tokens: 1500,
      prompt_tokens_details: { cached_tokens: 600 }
    })
    expect(result.cacheHitTokens).toBe(600)
    // miss 派生 = prompt - hit
    expect(result.cacheMissTokens).toBe(400)
  })

  it('无缓存数据时 hit=0, miss=0', () => {
    const result = normaliseUsage({
      prompt_tokens: 500,
      completion_tokens: 200
    })
    expect(result.cacheHitTokens).toBe(0)
    expect(result.cacheMissTokens).toBe(0)
  })

  it('reasoning_tokens 从 completion_tokens_details 提取', () => {
    const result = normaliseUsage({
      prompt_tokens: 100,
      completion_tokens: 300,
      completion_tokens_details: { reasoning_tokens: 200 }
    })
    expect(result.reasoningTokens).toBe(200)
  })

  it('finish_reason 透传', () => {
    expect(normaliseUsage({ finish_reason: 'stop' }).finishReason).toBe('stop')
    expect(normaliseUsage({}).finishReason).toBe('')
  })
})

describe('[功能] AutoMode 选项完整性', () => {
  it('三个选项值分别为 off/safe/yolo', () => {
    expect(AUTO_MODE_OPTIONS).toHaveLength(3)
    expect(AUTO_MODE_OPTIONS.map(o => o.value)).toEqual(['off', 'safe', 'yolo'])
  })

  it('每个选项有完整的 label/desc/icon/tone', () => {
    for (const opt of AUTO_MODE_OPTIONS) {
      expect(opt.label).toBeTruthy()
      expect(opt.desc).toBeTruthy()
      expect(opt.icon).toBeDefined()
      expect(['neutral', 'accent', 'danger']).toContain(opt.tone)
    }
  })
})

describe('[功能] 模型 ID 归一化', () => {
  it('历史 ID 迁移', () => {
    expect(normalizeModelId('deepseek-v4-flash')).toBe('deepseek-flash')
  })

  it('现行 ID 原样返回', () => {
    expect(normalizeModelId('deepseek-v4-pro')).toBe('deepseek-v4-pro')
    expect(normalizeModelId('deepseek-flash')).toBe('deepseek-flash')
  })

  it('自定义模型名原样返回', () => {
    expect(normalizeModelId('gpt-4o')).toBe('gpt-4o')
    expect(normalizeModelId('claude-3-opus')).toBe('claude-3-opus')
  })

  it('undefined 返回 undefined', () => {
    expect(normalizeModelId(undefined)).toBeUndefined()
  })

  it('getModelShortLabel', () => {
    expect(getModelShortLabel('deepseek-v4-pro')).toBe('V4 Pro')
    expect(getModelShortLabel('deepseek-flash')).toBe('Flash')
    expect(getModelShortLabel('gpt-4o')).toBe('gpt-4o')
    expect(getModelShortLabel(undefined)).toBe('')
  })
})

// ── 转录分组 ──────────────────────────────────────────────

function makeTranscriptItem(kind: string, id: string, extra: Record<string, unknown> = {}): TranscriptItem {
  return { kind, id, ...extra } as unknown as TranscriptItem
}

describe('[功能] 转录分组 — buildTurnGroups', () => {
  it('按用户消息分组', () => {
    const items: TranscriptItem[] = [
      makeTranscriptItem('user', 'u1', { text: 'question 1' }),
      makeTranscriptItem('assistant', 'a1', { text: 'answer 1', streaming: false }),
      makeTranscriptItem('user', 'u2', { text: 'question 2' }),
      makeTranscriptItem('assistant', 'a2', { text: 'answer 2', streaming: false }),
    ]
    const groups = buildTurnGroups(items)
    expect(groups).toHaveLength(2)
    expect(groups[0].userItem.id).toBe('u1')
    expect(groups[1].userItem.id).toBe('u2')
  })

  it('无用户消息时返回空数组', () => {
    const items: TranscriptItem[] = [
      makeTranscriptItem('assistant', 'a1', { text: 'answer', streaming: false })
    ]
    expect(buildTurnGroups(items)).toHaveLength(0)
  })

  it('工具调用计入 toolCount', () => {
    const items: TranscriptItem[] = [
      makeTranscriptItem('user', 'u1', { text: 'q' }),
      makeTranscriptItem('tool', 't1', { status: 'done' }),
      makeTranscriptItem('tool', 't2', { status: 'done' }),
    ]
    const groups = buildTurnGroups(items)
    expect(groups[0].toolCount).toBe(2)
  })
})

describe('[功能] 转录分组 — compactQuestionText', () => {
  it('短文本原样返回', () => {
    expect(compactQuestionText('hello world')).toBe('hello world')
  })

  it('长文本截断到 80 字符', () => {
    const long = 'a'.repeat(100)
    expect(compactQuestionText(long)).toHaveLength(80)
  })

  it('多空白合并', () => {
    expect(compactQuestionText('  hello   world  ')).toBe('hello world')
  })
})

describe('[功能] 转录分组 — warmPagination', () => {
  it('轮次少于 hotTurns 时无温区', () => {
    const result = warmPagination({ turnCount: 10, hotTurns: 30, pageSize: 20, coldPage: 0 })
    expect(result.warmEndTurn).toBe(0)
    expect(result.coldTurnCount).toBe(0)
  })

  it('轮次超过 hotTurns 时有温区', () => {
    const result = warmPagination({ turnCount: 50, hotTurns: 30, pageSize: 20, coldPage: 0 })
    expect(result.warmEndTurn).toBe(20)
    expect(result.warmStartTurn).toBe(0)
  })

  it('翻页时 warmStartTurn 前移', () => {
    const result = warmPagination({ turnCount: 50, hotTurns: 30, pageSize: 20, coldPage: 1 })
    expect(result.warmStartTurn).toBeLessThanOrEqual(result.warmEndTurn)
  })
})

describe('[功能] 转录分组 — scrollVersion', () => {
  it('相同 items 产生相同版本', () => {
    const items: TranscriptItem[] = [
      makeTranscriptItem('user', 'u1'),
      makeTranscriptItem('assistant', 'a1', { streaming: false }),
    ]
    expect(scrollVersion(items)).toBe(scrollVersion(items))
  })

  it('不同 items 产生不同版本', () => {
    const items1: TranscriptItem[] = [makeTranscriptItem('user', 'u1')]
    const items2: TranscriptItem[] = [makeTranscriptItem('user', 'u2')]
    expect(scrollVersion(items1)).not.toBe(scrollVersion(items2))
  })
})
