/**
 * 回归测试 — 已知 bug 场景防护
 *
 * 每个测试对应一个已发现并修复的 bug，确保不会重新出现。
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { normalizeModelId } from '../../src/shared/models'
import { normalizeAutoMode } from '../../src/renderer/src/lib/auto-mode'
import { normalizeToolSchemas } from '../../src/shared/cache/tool-normalize'
import { checkWriteAccess, setAllowedWriteRoots } from '../../src/main/security-guard'
import { checkSsrf } from '../../src/main/security-guard'
import { evaluate, CODING_DEFAULT_CONFIG } from '../../src/main/Permission'
import { truncateToolResult, trimContext } from '../../src/shared/context-compress'
import { getToolRetention, findToolName } from '../../src/shared/cache/tool-priority'
import { ContextManager } from '../../src/shared/cache/context-manager'
import { normaliseUsage } from '../../src/shared/cache/normalize-usage'
import { makeTitle } from '../../src/renderer/src/store/utils'

// ── BUG-001: lucide-bridge default export 导致黑屏 ───────

describe('[回归] BUG-001: lucide-bridge export default 导致 SyntaxError', () => {
  it('lucide-bridge.ts 不应 export default', async () => {
    const bridge = await import('../../src/renderer/src/lib/lucide-bridge')
    // 确认模块可以正常加载（不抛 SyntaxError）
    expect(bridge).toBeDefined()
    // 确认没有 default 导出
    expect((bridge as any).default).toBeUndefined()
  })
})

// ── BUG-002: 历史模型 ID 未迁移 ──────────────────────────

describe('[回归] BUG-002: deepseek-v4-flash 未迁移为 deepseek-flash', () => {
  it('normalizeModelId 迁移历史 ID', () => {
    expect(normalizeModelId('deepseek-v4-flash')).toBe('deepseek-flash')
  })

  it('老设置文件中的模型 ID 不会原样发给 API', () => {
    // 模拟从老设置文件读取
    const oldModel = 'deepseek-v4-flash'
    const newModel = normalizeModelId(oldModel)
    expect(newModel).not.toBe('deepseek-v4-flash')
    expect(newModel).toBe('deepseek-flash')
  })
})

// ── BUG-003: 路径前缀误判 ───────────────────────────────

describe('[回归] BUG-003: /tmp/pro 不应匹配白名单 /tmp/project', () => {
  it('相似前缀不误判为白名单内', () => {
    setAllowedWriteRoots(['/tmp/project'])
    expect(checkWriteAccess('/tmp/pro/secret.txt').allowed).toBe(false)
    expect(checkWriteAccess('/tmp/projectx/secret.txt').allowed).toBe(false)
  })

  it('精确白名单边界匹配', () => {
    setAllowedWriteRoots(['/tmp/project'])
    expect(checkWriteAccess('/tmp/project/file.txt').allowed).toBe(true)
    expect(checkWriteAccess('/tmp/project').allowed).toBe(true)
  })
})

// ── BUG-004: 工具 schema 顺序变化破坏 prompt cache ──────

describe('[回归] BUG-004: 工具列表顺序变化破坏缓存', () => {
  it('相同工具不同顺序产生相同排序结果', () => {
    const tools1 = [
      { name: 'c', description: 'C', parameters: { type: 'object' as const, properties: {} } },
      { name: 'a', description: 'A', parameters: { type: 'object' as const, properties: {} } },
      { name: 'b', description: 'B', parameters: { type: 'object' as const, properties: {} } }
    ]
    const tools2 = [
      { name: 'b', description: 'B', parameters: { type: 'object' as const, properties: {} } },
      { name: 'c', description: 'C', parameters: { type: 'object' as const, properties: {} } },
      { name: 'a', description: 'A', parameters: { type: 'object' as const, properties: {} } }
    ]
    const s1 = normalizeToolSchemas(tools1)
    const s2 = normalizeToolSchemas(tools2)
    expect(JSON.stringify(s1)).toBe(JSON.stringify(s2))
  })
})

// ── BUG-005: 路径穿越绕过写入保护 ───────────────────────

describe('[回归] BUG-005: ../ 路径穿越绕过白名单', () => {
  it('路径穿越被 normalize 解析后正确拦截', () => {
    setAllowedWriteRoots(['/tmp/project'])
    // /tmp/project/../../../etc/passwd → normalize 后为 /etc/passwd
    expect(checkWriteAccess('/tmp/project/../../../etc/passwd').allowed).toBe(false)
  })
})

// ── BUG-006: 连续 compact 进入 stuck 后无法恢复 ─────────

describe('[回归] BUG-006: compact stuck 后无法恢复', () => {
  it('token 降回阈值以下时清除 stuck 状态', () => {
    const cm = new ContextManager()
    const high = 10000 * 0.8

    // 触发 stuck
    cm.maybeCompact({ messages: [], config: { maxToolResultChars: 8000, maxContextChars: 300000, recentKeep: 5, snippedKeep: 200, prunedKeep: 80 }, promptTokens: Math.floor(high) + 1, contextWindow: 10000 })
    cm.maybeCompact({ messages: [], config: { maxToolResultChars: 8000, maxContextChars: 300000, recentKeep: 5, snippedKeep: 200, prunedKeep: 80 }, promptTokens: Math.floor(high) + 1, contextWindow: 10000 })
    expect(cm.compactStuck).toBe(true)

    // token 降到阈值以下 → 清除 stuck
    cm.maybeCompact({ messages: [], config: { maxToolResultChars: 8000, maxContextChars: 300000, recentKeep: 5, snippedKeep: 200, prunedKeep: 80 }, promptTokens: 100, contextWindow: 10000 })
    expect(cm.compactStuck).toBe(false)
    expect(cm.consecutiveCompacts).toBe(0)
  })
})

// ── BUG-007: normaliseUsage 在缺失字段时崩溃 ─────────────

describe('[回归] BUG-007: normaliseUsage 空对象崩溃', () => {
  it('空对象不崩溃，返回全 0', () => {
    const result = normaliseUsage({})
    expect(result.promptTokens).toBe(0)
    expect(result.completionTokens).toBe(0)
    expect(result.totalTokens).toBe(0)
    expect(result.cacheHitTokens).toBe(0)
    expect(result.cacheMissTokens).toBe(0)
  })

  it('只有 prompt_tokens 时 totalTokens 正确派生', () => {
    const result = normaliseUsage({ prompt_tokens: 500 })
    expect(result.totalTokens).toBe(500)
  })
})

// ── BUG-008: trimContext 双重截断 ────────────────────────

describe('[回归] BUG-008: 已截断的内容被再次截断', () => {
  it('已有截断标记的内容不被 snip 再次处理', () => {
    const messages = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'work' },
      { role: 'assistant', content: '', tool_calls: [{ id: 'tc1', function: { name: 'file_read' } }] },
      { role: 'tool', content: 'X'.repeat(50) + '\n[...已自动截断以节省上下文空间]', tool_call_id: 'tc1' },
      { role: 'user', content: 'recent' }
    ]
    const contentBefore = messages[3].content

    trimContext(messages, {
      maxToolResultChars: 8000,
      maxContextChars: 100,
      recentKeep: 3,
      snippedKeep: 20,
      prunedKeep: 5
    })

    // snip 阶段跳过已有截断标记的内容
    // 注意：prune 阶段可能仍会处理（不同标记），但 snip 不应重复
    const snipMarkers = messages[3].content.match(/已自动截断/g) || []
    expect(snipMarkers.length).toBeLessThanOrEqual(1)
  })

  it('已有省略标记的内容不被 prune 再次处理', () => {
    const messages = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'work' },
      { role: 'assistant', content: '', tool_calls: [{ id: 'tc1', function: { name: 'file_read' } }] },
      { role: 'tool', content: 'X'.repeat(50) + '\n[...已省略]', tool_call_id: 'tc1' },
      { role: 'user', content: 'recent' }
    ]

    trimContext(messages, {
      maxToolResultChars: 8000,
      maxContextChars: 50,
      recentKeep: 3,
      snippedKeep: 20,
      prunedKeep: 5
    })

    const omitMarkers = messages[3].content.match(/已省略/g) || []
    expect(omitMarkers.length).toBeLessThanOrEqual(1)
  })
})

// ── BUG-009: findToolName 在无 tool_calls 时崩溃 ──────────

describe('[回归] BUG-009: findToolName 无 tool_call_id 时崩溃', () => {
  it('无 tool_call_id 返回 null 而非崩溃', () => {
    const messages = [
      { role: 'tool', tool_call_id: undefined }
    ]
    expect(findToolName(messages, 0)).toBeNull()
  })

  it('找不到匹配的 assistant 消息返回 null', () => {
    const messages = [
      { role: 'user', content: 'hi' },
      { role: 'tool', tool_call_id: 'nonexistent' }
    ]
    expect(findToolName(messages, 1)).toBeNull()
  })
})

// ── BUG-010: AUTO_MODE_OPTIONS 值与 AutoModeLevel 不匹配 ─

describe('[回归] BUG-010: AutoMode 选项值与类型定义不一致', () => {
  it('三个选项值恰好是 off/safe/yolo', async () => {
    const { AUTO_MODE_OPTIONS } = await import('../../src/renderer/src/lib/auto-mode')
    const values = AUTO_MODE_OPTIONS.map((o: any) => o.value)
    expect(values).toEqual(['off', 'safe', 'yolo'])
  })
})

// ── BUG-011: checkSsrf 对 IPv6 链路本地地址漏判 ──────────

describe('[回归] BUG-011: IPv6 链路本地地址 SSRF 漏判', () => {
  it('fe80:: 链路本地被阻止', () => {
    expect(checkSsrf('http://[fe80::1]/').blocked).toBe(true)
  })

  it('fc00:: 唯一本地被阻止', () => {
    expect(checkSsrf('http://[fc00::1]/').blocked).toBe(true)
  })

  it('fd 开头 IPv6 本地被阻止', () => {
    expect(checkSsrf('http://[fd00::1]/').blocked).toBe(true)
  })
})

// ── BUG-012: coding 模式下 file_write 被 ask 而非 allow ──

describe('[回归] BUG-012: coding 模式 file_write 权限错误', () => {
  it('coding 模式 file_write 应为 allow（有 checkpoint 保障）', () => {
    expect(evaluate(CODING_DEFAULT_CONFIG, 'file_write', '')).toBe('allow')
  })

  it('coding 模式 file_edit 应为 allow', () => {
    expect(evaluate(CODING_DEFAULT_CONFIG, 'file_edit', '')).toBe('allow')
  })

  it('coding 模式 multi_edit 应为 allow', () => {
    expect(evaluate(CODING_DEFAULT_CONFIG, 'multi_edit', '')).toBe('allow')
  })
})

// ── BUG-013: makeTitle 空字符串返回 undefined 而非"新对话" ─

describe('[回归] BUG-013: makeTitle 空字符串返回非空默认值', () => {
  it('空字符串返回"新对话"', () => {
    expect(makeTitle('')).toBe('新对话')
  })

  it('纯空白返回"新对话"', () => {
    expect(makeTitle('  \n\t  ')).toBe('新对话')
  })
})

// ── BUG-014: getToolRetention 对未知工具崩溃 ─────────────

describe('[回归] BUG-014: getToolRetention 未知工具崩溃', () => {
  it('null 返回 low', () => {
    expect(getToolRetention(null)).toBe('low')
  })

  it('undefined 返回 low', () => {
    expect(getToolRetention(undefined)).toBe('low')
  })

  it('空字符串返回 low', () => {
    expect(getToolRetention('')).toBe('low')
  })
})

// ── BUG-015: truncateToolResult 在空内容时崩溃 ───────────

describe('[回归] BUG-015: truncateToolResult 空内容崩溃', () => {
  it('空字符串原样返回', () => {
    const result = truncateToolResult('', {
      maxToolResultChars: 8000,
      maxContextChars: 300000,
      recentKeep: 5,
      snippedKeep: 200,
      prunedKeep: 80
    })
    expect(result).toBe('')
  })

  it('null 不崩溃（返回 null）', () => {
    const result = truncateToolResult(null as any, {
      maxToolResultChars: 8000,
      maxContextChars: 300000,
      recentKeep: 5,
      snippedKeep: 200,
      prunedKeep: 80
    })
    expect(result).toBeNull()
  })
})
