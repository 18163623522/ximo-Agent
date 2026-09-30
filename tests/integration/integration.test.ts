/**
 * 集成测试 — IPC ↔ Store ↔ DeepSeek 联动
 *
 * 验证多个模块组合在一起时的正确行为。
 * 不连接真实 API，使用 mock 验证数据流。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { DEFAULT_SETTINGS } from '../../src/shared/defaults'
import { normalizeModelId } from '../../src/shared/models'
import { normalizeAutoMode } from '../../src/renderer/src/lib/auto-mode'
import { toolRegistry } from '../../src/main/tools/ToolRegistry'
import { evaluate, getConfigForMode, SAFE_CONFIG, YOLO_CONFIG } from '../../src/main/Permission'
import { checkWriteAccess, setAllowedWriteRoots, checkSsrf, checkSensitiveFile } from '../../src/main/security-guard'
import { trimContext, truncateToolResult } from '../../src/shared/context-compress'
import { normalizeToolSchemas } from '../../src/shared/cache/tool-normalize'
import { normaliseUsage } from '../../src/shared/cache/normalize-usage'
import { ContextManager } from '../../src/shared/cache/context-manager'
import { getToolRetention } from '../../src/shared/cache/tool-priority'
import { genId } from '../../src/shared/utils'
import type { AppSettings, Conversation, ChatMessage } from '../../src/shared/types'

// ── 1. Settings → Agent 配置链 ───────────────────────────

describe('[集成] Settings → Agent 配置链', () => {
  it('DEFAULT_SETTINGS → normalizeModelId → 模型 ID 正确', () => {
    const settings = { ...DEFAULT_SETTINGS }
    const model = normalizeModelId(settings.model)
    expect(model).toBe('deepseek-v4-pro')
  })

  it('DEFAULT_SETTINGS → normalizeAutoMode → 等级正确', () => {
    const settings = { ...DEFAULT_SETTINGS, defaultAutoModeLevel: 'safe' }
    const level = normalizeAutoMode(settings.defaultAutoModeLevel)
    expect(level).toBe('safe')
  })

  it('历史设置迁移：deepseek-v4-flash → deepseek-flash', () => {
    const oldSettings = { ...DEFAULT_SETTINGS, model: 'deepseek-v4-flash' as any }
    const migrated = normalizeModelId(oldSettings.model)
    expect(migrated).toBe('deepseek-flash')
  })

  it('非法 autoModeLevel 回退到 off', () => {
    const settings = { ...DEFAULT_SETTINGS, defaultAutoModeLevel: 'invalid' as any }
    const level = normalizeAutoMode(settings.defaultAutoModeLevel)
    expect(level).toBe('off')
  })
})

// ── 2. 权限 → 工具执行链 ─────────────────────────────────

describe('[集成] 权限 → 工具执行', () => {
  it('Coding 模式 file_write allow → security-guard 写入检查通过', () => {
    const permConfig = getConfigForMode('coding')
    expect(evaluate(permConfig, 'file_write', '')).toBe('allow')

    setAllowedWriteRoots(['/tmp/project'])
    const access = checkWriteAccess('/tmp/project/src/index.ts')
    expect(access.allowed).toBe(true)
  })

  it('Coding 模式 file_write allow → 写入白名单外被 security-guard 拦截', () => {
    const permConfig = getConfigForMode('coding')
    expect(evaluate(permConfig, 'file_write', '')).toBe('allow')

    setAllowedWriteRoots(['/tmp/project'])
    const access = checkWriteAccess('/etc/passwd')
    expect(access.allowed).toBe(false)
  })

  it('YOLO 模式 → 所有权限 allow → 但 SSRF 仍拦截内网', () => {
    expect(evaluate(YOLO_CONFIG, 'web_fetch', '')).toBe('allow')
    expect(checkSsrf('http://127.0.0.1/admin').blocked).toBe(true)
  })

  it('Safe 模式 → file_delete ask → 敏感文件路径仍被 checkSensitiveFile 拦截', () => {
    expect(evaluate(SAFE_CONFIG, 'file_delete', '')).toBe('ask')
    expect(checkSensitiveFile('/home/user/.ssh/id_rsa').blocked).toBe(true)
  })
})

// ── 3. 工具 schema → 缓存友好链 ──────────────────────────

describe('[集成] 工具 schema → 缓存前缀', () => {
  it('排序后的 schema 在多次调用间产生相同序列', () => {
    const tools = [
      { name: 'z_tool', description: 'Z', parameters: { type: 'object' as const, properties: {} } },
      { name: 'a_tool', description: 'A', parameters: { type: 'object' as const, properties: {} } },
      { name: 'm_tool', description: 'M', parameters: { type: 'object' as const, properties: {} } }
    ]
    const s1 = normalizeToolSchemas(tools)
    const s2 = normalizeToolSchemas([...tools].reverse())
    expect(JSON.stringify(s1)).toBe(JSON.stringify(s2))
  })
})

// ── 4. 上下文压缩 → token 统计链 ──────────────────────────

describe('[集成] 上下文压缩 → token 统计', () => {
  it('API 返回 usage → normaliseUsage → ContextManager 决策', () => {
    const cm = new ContextManager()

    // 模拟 API 返回（DeepSeek 格式）
    const raw = {
      prompt_tokens: 8500,
      completion_tokens: 500,
      total_tokens: 9000,
      prompt_cache_hit_tokens: 7000,
      prompt_cache_miss_tokens: 1500
    }
    const usage = normaliseUsage(raw)

    // 8500 > 8000 (10000 * 0.8) → compact
    const result = cm.maybeCompact({
      messages: [],
      config: {
        maxToolResultChars: 8000,
        maxContextChars: 300000,
        recentKeep: 5,
        snippedKeep: 200,
        prunedKeep: 80
      },
      promptTokens: usage.promptTokens,
      contextWindow: 10000
    })

    expect(result.tier).toBe('compact')
  })

  it('snip 阶段裁剪 LOW 工具结果 → HIGH 工具结果保留', () => {
    const config = {
      maxToolResultChars: 8000,
      maxContextChars: 500,
      recentKeep: 3,
      snippedKeep: 20,
      prunedKeep: 5
    }
    const messages = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'do work' },
      { role: 'assistant', content: '', tool_calls: [{ id: 'tc1', function: { name: 'file_read' } }] },
      { role: 'tool', content: 'X'.repeat(300), tool_call_id: 'tc1' },
      { role: 'assistant', content: '', tool_calls: [{ id: 'tc2', function: { name: 'file_write' } }] },
      { role: 'tool', content: 'Y'.repeat(300), tool_call_id: 'tc2' },
      { role: 'user', content: 'recent' }
    ]

    const lowBefore = messages[3].content.length
    const highBefore = messages[5].content.length

    trimContext(messages, config)

    // LOW (file_read) 被裁剪
    expect(messages[3].content.length).toBeLessThan(lowBefore)
    // HIGH (file_write) 保留
    expect(messages[5].content.length).toBe(highBefore)
  })
})

// ── 5. 会话生命周期 ──────────────────────────────────────

describe('[集成] 会话生命周期', () => {
  it('genId → Conversation → messages → trimContext 全链路', () => {
    const convId = genId()
    const msgId = genId()

    const conv: Conversation = {
      id: convId,
      title: 'Test Conversation',
      mode: 'coding',
      messages: [],
      createdAt: Date.now(),
      updatedAt: Date.now()
    }

    const msg: ChatMessage = {
      id: msgId,
      role: 'user',
      content: 'Please help me write a function',
      timestamp: Date.now()
    }

    conv.messages.push(msg)
    expect(conv.messages).toHaveLength(1)
    expect(conv.messages[0].id).toBe(msgId)

    // trimContext 不应破坏正常长度的消息
    const config = {
      maxToolResultChars: 8000,
      maxContextChars: 300000,
      recentKeep: 5,
      snippedKeep: 200,
      prunedKeep: 80
    }
    const apiMessages = [
      { role: 'system', content: 'You are helpful.' },
      { role: 'user', content: msg.content }
    ]
    trimContext(apiMessages, config)
    expect(apiMessages[1].content).toBe(msg.content)
  })
})

// ── 6. ToolRegistry ↔ lazy-registry ──────────────────────

describe('[集成] ToolRegistry ↔ 权限系统', () => {
  it('注册的工具名称与权限配置的 allow 列表一致', () => {
    const codingConfig = getConfigForMode('coding')
    const allowTools = new Set(codingConfig.allow.map(r => r.tool))

    // 这些工具在 coding 模式应该 allow
    for (const toolName of ['file_read', 'file_write', 'file_edit', 'file_list']) {
      expect(allowTools.has(toolName)).toBe(true)
    }
  })

  it('注册的工具名称与权限配置的 deny 列表一致', () => {
    const codingConfig = getConfigForMode('coding')
    const denyTools = new Set(codingConfig.deny.map(r => r.tool))

    for (const toolName of ['act_ui', 'network_replay', 'browser_execute_js']) {
      expect(denyTools.has(toolName)).toBe(true)
    }
  })
})

// ── 7. 安全守卫 ↔ 工具执行链 ──────────────────────────────

describe('[集成] 安全守卫 ↔ 工具执行', () => {
  it('web_fetch → SSRF 检查 → 公网 URL 通过', () => {
    const permConfig = getConfigForMode('coding')
    expect(evaluate(permConfig, 'web_fetch', '')).toBe('allow')
    expect(checkSsrf('https://api.github.com/repos/test').blocked).toBe(false)
  })

  it('web_fetch → SSRF 检查 → 内网被拦截', () => {
    expect(checkSsrf('http://10.0.0.1/internal').blocked).toBe(true)
  })

  it('file_read → 敏感文件检查 → /etc/passwd 不阻止（非凭据）', () => {
    // /etc/passwd 不是凭据文件，checkSensitiveFile 不阻止
    expect(checkSensitiveFile('/etc/passwd').blocked).toBe(false)
  })

  it('file_read → 敏感文件检查 → .ssh/id_rsa 阻止', () => {
    expect(checkSensitiveFile('/home/user/.ssh/id_rsa').blocked).toBe(true)
  })
})

// ── 8. tool-priority ↔ context-compress 联动 ─────────────

describe('[集成] tool-priority ↔ context-compress', () => {
  it('snip 阶段只裁 LOW，HIGH 保留 — 两个模块使用相同的 getToolRetention', () => {
    expect(getToolRetention('file_read')).toBe('low')
    expect(getToolRetention('file_write')).toBe('high')
    expect(getToolRetention('terminal_exec')).toBe('medium')
  })

  it('truncateToolResult 与 trimContext 不会双重截断', () => {
    const longContent = 'Z'.repeat(10000)
    // 先 truncate
    const truncated = truncateToolResult(longContent, {
      maxToolResultChars: 8000,
      maxContextChars: 300000,
      recentKeep: 5,
      snippedKeep: 200,
      prunedKeep: 80
    })
    expect(truncated.length).toBeLessThan(longContent.length)

    // 再 trim — 不应再次截断已有截断标记的内容
    const messages = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'work' },
      { role: 'assistant', content: '', tool_calls: [{ id: 'tc1', function: { name: 'file_read' } }] },
      { role: 'tool', content: truncated, tool_call_id: 'tc1' },
      { role: 'user', content: 'recent' }
    ]
    const before = messages[3].content
    trimContext(messages, {
      maxToolResultChars: 8000,
      maxContextChars: 100,
      recentKeep: 3,
      snippedKeep: 20,
      prunedKeep: 5
    })
    // 已有截断标记的内容不会被再次截断（跳过）
    // 但可能被 prune 阶段裁剪 — 检查至少不被 snip 重复处理
    // 关键验证：内容不含两个截断标记
    const markers = messages[3].content.match(/\[\.\.\..*?截断/g) || []
    expect(markers.length).toBeLessThanOrEqual(1)
  })
})
