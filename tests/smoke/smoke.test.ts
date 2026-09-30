/**
 * 冒烟测试 — 验证核心启动链路可跑通
 *
 * 目标：在最短时间内确认项目的基础模块可正常 import、核心类型/常量可用。
 * 如果冒烟测试都跑不过，说明构建已断裂。
 */
import { describe, it, expect } from 'vitest'

// ── 1. 类型与常量 ──────────────────────────────────────────

describe('[冒烟] 类型与常量', () => {
  it('DEFAULT_SETTINGS 可导入且含必填字段', async () => {
    const { DEFAULT_SETTINGS } = await import('../../src/shared/defaults')
    expect(DEFAULT_SETTINGS).toBeDefined()
    expect(DEFAULT_SETTINGS.baseUrl).toBe('https://api.deepseek.com/v1')
    expect(DEFAULT_SETTINGS.model).toBe('deepseek-v4-pro')
    expect(DEFAULT_SETTINGS.theme).toBe('dark')
  })

  it('Mode 类型包含 office/coding/design', async () => {
    const { modeToolNames } = await import('../../src/main/tools/lazy-registry')
    expect(modeToolNames).toHaveProperty('office')
    expect(modeToolNames).toHaveProperty('coding')
    expect(modeToolNames).toHaveProperty('design')
    expect(modeToolNames.office.length).toBeGreaterThan(0)
    expect(modeToolNames.coding.length).toBeGreaterThan(0)
    expect(modeToolNames.design.length).toBeGreaterThan(0)
  })

  it('模型 ID 常量存在', async () => {
    const { DS_MODEL_PRO, DS_MODEL_FLASH } = await import('../../src/shared/models')
    expect(DS_MODEL_PRO).toBe('deepseek-v4-pro')
    expect(DS_MODEL_FLASH).toBe('deepseek-flash')
  })
})

// ── 2. 工具注册表 ──────────────────────────────────────────

describe('[冒烟] 工具注册表', () => {
  it('ToolRegistry 可实例化并 register/get', async () => {
    const { ToolRegistry } = await import('../../src/main/tools/ToolRegistry')
    const reg = new ToolRegistry()
    const tool = {
      definition: {
        name: 'test_tool',
        description: 'A test tool',
        parameters: { type: 'object' as const, properties: {} }
      },
      execute: async () => ({
        toolCallId: '1', toolName: 'test_tool', content: '', success: true
      })
    }
    reg.register(tool)
    expect(reg.has('test_tool')).toBe(true)
    expect(reg.get('test_tool')).toBe(tool)
    expect(reg.get('nonexistent')).toBeUndefined()
  })

  it('getByNames 过滤未注册的工具', async () => {
    const { ToolRegistry } = await import('../../src/main/tools/ToolRegistry')
    const reg = new ToolRegistry()
    const tool = {
      definition: { name: 'a', description: '', parameters: { type: 'object' as const, properties: {} } },
      execute: async () => ({ toolCallId: '', toolName: 'a', content: '', success: true })
    }
    reg.register(tool)
    const found = reg.getByNames(['a', 'b'])
    expect(found).toHaveLength(1)
    expect(found[0].definition.name).toBe('a')
  })
})

// ── 3. 权限系统 ──────────────────────────────────────────

describe('[冒烟] 权限系统', () => {
  it('evaluate 函数可调用', async () => {
    const { evaluate, CODING_DEFAULT_CONFIG } = await import('../../src/main/Permission')
    const decision = evaluate(CODING_DEFAULT_CONFIG, 'file_read', '')
    expect(decision).toBe('allow')
  })

  it('getConfigForMode 返回有效配置', async () => {
    const { getConfigForMode } = await import('../../src/main/Permission')
    for (const mode of ['coding', 'office', 'design']) {
      const config = getConfigForMode(mode)
      expect(config).toBeDefined()
      expect(config.allow).toBeDefined()
      expect(config.ask).toBeDefined()
      expect(config.deny).toBeDefined()
    }
  })
})

// ── 4. 安全守卫 ──────────────────────────────────────────

describe('[冒烟] 安全守卫', () => {
  it('checkWriteAccess 可调用', async () => {
    const { checkWriteAccess, setAllowedWriteRoots } = await import('../../src/main/security-guard')
    setAllowedWriteRoots(['/tmp'])
    const result = checkWriteAccess('/tmp/test.txt')
    expect(result.allowed).toBe(true)
  })

  it('checkSsrf 可调用', async () => {
    const { checkSsrf } = await import('../../src/main/security-guard')
    expect(checkSsrf('https://example.com').blocked).toBe(false)
    expect(checkSsrf('http://169.254.169.254/').blocked).toBe(true)
  })

  it('checkSensitiveFile 可调用', async () => {
    const { checkSensitiveFile } = await import('../../src/main/security-guard')
    expect(checkSensitiveFile('/home/user/.ssh/id_rsa').blocked).toBe(true)
    expect(checkSensitiveFile('/tmp/test.txt').blocked).toBe(false)
  })
})

// ── 5. 上下文压缩 ──────────────────────────────────────────

describe('[冒烟] 上下文压缩', () => {
  it('trimContext 可调用', async () => {
    const { trimContext } = await import('../../src/shared/context-compress')
    const messages = [
      { role: 'system', content: 'You are helpful.' },
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello' }
    ]
    trimContext(messages, {
      maxToolResultChars: 8000,
      maxContextChars: 300000,
      recentKeep: 5,
      snippedKeep: 200,
      prunedKeep: 80
    })
    expect(messages).toHaveLength(3)
  })

  it('ContextManager 可实例化', async () => {
    const { ContextManager } = await import('../../src/shared/cache/context-manager')
    const cm = new ContextManager()
    expect(cm.consecutiveCompacts).toBe(0)
    expect(cm.compactStuck).toBe(false)
  })
})

// ── 6. 工具 schema 归一化 ──────────────────────────────────

describe('[冒烟] 工具 schema 归一化', () => {
  it('normalizeToolSchemas 按名称排序', async () => {
    const { normalizeToolSchemas } = await import('../../src/shared/cache/tool-normalize')
    const tools = [
      { name: 'z_tool', description: 'Z', parameters: { type: 'object' as const, properties: {} } },
      { name: 'a_tool', description: 'A', parameters: { type: 'object' as const, properties: {} } },
      { name: 'm_tool', description: 'M', parameters: { type: 'object' as const, properties: {} } }
    ]
    const sorted = normalizeToolSchemas(tools)
    expect(sorted[0].name).toBe('a_tool')
    expect(sorted[2].name).toBe('z_tool')
  })
})

// ── 7. ID 生成 ──────────────────────────────────────────

describe('[冒烟] ID 生成', () => {
  it('genId 生成唯一字符串', async () => {
    const { genId } = await import('../../src/shared/utils')
    const ids = new Set<string>()
    for (let i = 0; i < 1000; i++) {
      ids.add(genId())
    }
    expect(ids.size).toBe(1000)
  })
})

// ── 8. Auto Mode 归一化 ──────────────────────────────────

describe('[冒烟] Auto Mode', () => {
  it('normalizeAutoMode 合法值透传', async () => {
    const { normalizeAutoMode } = await import('../../src/renderer/src/lib/auto-mode')
    expect(normalizeAutoMode('off')).toBe('off')
    expect(normalizeAutoMode('safe')).toBe('safe')
    expect(normalizeAutoMode('yolo')).toBe('yolo')
  })

  it('normalizeAutoMode 非法值回退到 off', async () => {
    const { normalizeAutoMode } = await import('../../src/renderer/src/lib/auto-mode')
    expect(normalizeAutoMode('invalid')).toBe('off')
    expect(normalizeAutoMode(null)).toBe('off')
    expect(normalizeAutoMode(undefined)).toBe('off')
    expect(normalizeAutoMode(123)).toBe('off')
  })
})

// ── 9. 模型 ID 归一化 ──────────────────────────────────────

describe('[冒烟] 模型 ID', () => {
  it('normalizeModelId 迁移历史 ID', async () => {
    const { normalizeModelId } = await import('../../src/shared/models')
    expect(normalizeModelId('deepseek-v4-flash')).toBe('deepseek-flash')
    expect(normalizeModelId('deepseek-v4-pro')).toBe('deepseek-v4-pro')
    expect(normalizeModelId(undefined)).toBeUndefined()
  })

  it('getModelLabel 返回展示名', async () => {
    const { getModelLabel } = await import('../../src/shared/models')
    expect(getModelLabel('deepseek-v4-pro')).toBe('DeepSeek V4 Pro')
    expect(getModelLabel('deepseek-flash')).toBe('DeepSeek Flash')
    expect(getModelLabel('gpt-4o')).toBe('gpt-4o')
    expect(getModelLabel(undefined)).toBe('')
  })
})
