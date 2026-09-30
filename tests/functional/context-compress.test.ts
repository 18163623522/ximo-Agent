/**
 * 功能测试 — 上下文压缩系统
 *
 * 测试 trimContext (静态压缩)、ContextManager (动态压缩)、tool-priority (优先级)。
 */
import { describe, it, expect } from 'vitest'
import { trimContext, truncateToolResult, totalChars } from '../../src/shared/context-compress'
import { getToolRetention, findToolName } from '../../src/shared/cache/tool-priority'
import { ContextManager } from '../../src/shared/cache/context-manager'
import type { AgentConfig } from '../../src/shared/context-compress'

const config: AgentConfig = {
  maxToolResultChars: 8000,
  maxContextChars: 1000,
  recentKeep: 3,
  snippedKeep: 50,
  prunedKeep: 20
}

describe('[功能] truncateToolResult', () => {
  it('短内容不截断', () => {
    expect(truncateToolResult('short content', config)).toBe('short content')
  })

  it('超长内容被截断并添加提示', () => {
    const long = 'x'.repeat(10000)
    const result = truncateToolResult(long, config)
    expect(result.length).toBeLessThan(long.length)
    expect(result).toContain('[...结果已截断')
    expect(result).toContain('10000')
  })

  it('空内容原样返回', () => {
    expect(truncateToolResult('', config)).toBe('')
  })
})

describe('[功能] totalChars', () => {
  it('计算所有消息内容字符数总和', () => {
    const messages = [
      { content: 'hello' },
      { content: 'world' },
      { content: undefined }
    ]
    expect(totalChars(messages)).toBe(10)
  })
})

describe('[功能] trimContext — 静态压缩', () => {
  it('总字符数低于阈值时不操作', () => {
    const messages = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'hi' }
    ]
    const before = JSON.stringify(messages)
    trimContext(messages, config)
    expect(JSON.stringify(messages)).toBe(before)
  })

  it('snip 阶段只裁剪 LOW 优先级 tool 结果', () => {
    // 构造超阈值的消息列表
    const longLowContent = 'A'.repeat(600)
    const messages = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'do something' },
      { role: 'assistant', content: '', tool_calls: [{ id: 'tc1', type: 'function', function: { name: 'file_read', arguments: '{}' } }] },
      { role: 'tool', content: longLowContent, tool_call_id: 'tc1' },
      { role: 'assistant', content: '', tool_calls: [{ id: 'tc2', type: 'function', function: { name: 'file_write', arguments: '{}' } }] },
      { role: 'tool', content: 'B'.repeat(600), tool_call_id: 'tc2' },
      { role: 'user', content: 'recent' },
    ]
    const originalLowLen = messages[3].content.length
    const originalHighLen = messages[5].content.length

    trimContext(messages, config)

    // LOW (file_read) 应被截断
    expect(messages[3].content.length).toBeLessThan(originalLowLen)
    expect(messages[3].content).toContain('[...已自动截断')
    // HIGH (file_write) 不应被截断
    expect(messages[5].content.length).toBe(originalHighLen)
  })
})

describe('[功能] getToolRetention', () => {
  it('HIGH — 代码变更工具', () => {
    expect(getToolRetention('file_write')).toBe('high')
    expect(getToolRetention('file_edit')).toBe('high')
    expect(getToolRetention('file_create')).toBe('high')
    expect(getToolRetention('file_delete')).toBe('high')
    expect(getToolRetention('move_file')).toBe('high')
  })

  it('MEDIUM — 构建/测试工具', () => {
    expect(getToolRetention('terminal_exec')).toBe('medium')
    expect(getToolRetention('code_lint')).toBe('medium')
    expect(getToolRetention('code_review')).toBe('medium')
    expect(getToolRetention('dependency_check')).toBe('medium')
  })

  it('LOW — 可重新获取的工具', () => {
    expect(getToolRetention('file_read')).toBe('low')
    expect(getToolRetention('web_search')).toBe('low')
    expect(getToolRetention('unknown_tool')).toBe('low')
    expect(getToolRetention(null)).toBe('low')
    expect(getToolRetention(undefined)).toBe('low')
  })
})

describe('[功能] findToolName', () => {
  it('通过 tool_call_id 找到工具名', () => {
    const messages = [
      { role: 'assistant', tool_calls: [{ id: 'tc1', function: { name: 'file_read' } }] },
      { role: 'tool', tool_call_id: 'tc1' }
    ]
    expect(findToolName(messages, 1)).toBe('file_read')
  })

  it('找不到时返回 null', () => {
    const messages = [
      { role: 'assistant', tool_calls: [{ id: 'tc1', function: { name: 'file_read' } }] },
      { role: 'tool', tool_call_id: 'tc_nonexistent' }
    ]
    expect(findToolName(messages, 1)).toBeNull()
  })

  it('无 tool_call_id 时返回 null', () => {
    const messages = [
      { role: 'tool', tool_call_id: undefined }
    ]
    expect(findToolName(messages, 0)).toBeNull()
  })
})

describe('[功能] ContextManager — 动态压缩', () => {
  it('低于阈值时返回 none', () => {
    const cm = new ContextManager()
    const result = cm.maybeCompact({
      messages: [],
      config,
      promptTokens: 100,
      contextWindow: 10000
    })
    expect(result.tier).toBe('none')
  })

  it('达到 soft 阈值时通知一次', () => {
    const cm = new ContextManager()
    const ratio = 0.8
    const soft = 10000 * ratio * 0.625 // 5000

    const r1 = cm.maybeCompact({
      messages: [],
      config,
      promptTokens: Math.floor(soft),
      contextWindow: 10000
    })
    expect(r1.tier).toBe('soft')

    // 第二次不重复通知
    const r2 = cm.maybeCompact({
      messages: [],
      config,
      promptTokens: Math.floor(soft),
      contextWindow: 10000
    })
    expect(r2.tier).toBe('none')
  })

  it('达到 compact 阈值时返回 compact', () => {
    const cm = new ContextManager()
    const high = 10000 * 0.8 // 8000

    const result = cm.maybeCompact({
      messages: [],
      config,
      promptTokens: Math.floor(high) + 1,
      contextWindow: 10000
    })
    expect(result.tier).toBe('compact')
  })

  it('连续 2 次 compact 后进入 stuck', () => {
    const cm = new ContextManager()
    const high = 10000 * 0.8

    cm.maybeCompact({ messages: [], config, promptTokens: Math.floor(high) + 1, contextWindow: 10000 })
    expect(cm.compactStuck).toBe(false)

    cm.maybeCompact({ messages: [], config, promptTokens: Math.floor(high) + 1, contextWindow: 10000 })
    expect(cm.compactStuck).toBe(true)
  })

  it('stuck 时暂停自动压缩', () => {
    const cm = new ContextManager()
    const high = 10000 * 0.8

    // 触发 2 次 compact 进入 stuck
    cm.maybeCompact({ messages: [], config, promptTokens: Math.floor(high) + 1, contextWindow: 10000 })
    cm.maybeCompact({ messages: [], config, promptTokens: Math.floor(high) + 1, contextWindow: 10000 })

    // stuck 后应暂停
    const r = cm.maybeCompact({ messages: [], config, promptTokens: Math.floor(high) + 1, contextWindow: 10000 })
    expect(r.stuckPaused).toBe(true)
  })

  it('reset 清除所有状态', () => {
    const cm = new ContextManager()
    cm.consecutiveCompacts = 5
    cm.compactStuck = true
    cm.softNoticed = true
    cm.rewriteVersion = 3

    cm.reset()

    expect(cm.consecutiveCompacts).toBe(0)
    expect(cm.compactStuck).toBe(false)
    expect(cm.softNoticed).toBe(false)
    expect(cm.rewriteVersion).toBe(0)
  })

  it('contextWindow 为 0 时禁用', () => {
    const cm = new ContextManager()
    const result = cm.maybeCompact({
      messages: [],
      config,
      promptTokens: 999999,
      contextWindow: 0
    })
    expect(result.tier).toBe('none')
  })

  it('promptTokens 为 0 时禁用', () => {
    const cm = new ContextManager()
    const result = cm.maybeCompact({
      messages: [],
      config,
      promptTokens: 0,
      contextWindow: 10000
    })
    expect(result.tier).toBe('none')
  })
})
