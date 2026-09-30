/**
 * 模糊测试 — 输入边界、非法参数
 *
 * 向各模块投入随机/极端输入，验证不崩溃、不抛未捕获异常。
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { checkSsrf, checkSensitiveFile, checkWriteAccess, setAllowedWriteRoots } from '../../src/main/security-guard'
import { evaluate, extractSubject, getConfigForMode, YOLO_CONFIG } from '../../src/main/Permission'
import { normalizeToolSchemas } from '../../src/shared/cache/tool-normalize'
import { normaliseUsage } from '../../src/shared/cache/normalize-usage'
import { trimContext, truncateToolResult, totalChars } from '../../src/shared/context-compress'
import { ContextManager } from '../../src/shared/cache/context-manager'
import { genId } from '../../src/shared/utils'
import { normalizeAutoMode } from '../../src/renderer/src/lib/auto-mode'
import { normalizeModelId, getModelLabel } from '../../src/shared/models'
import { makeTitle } from '../../src/renderer/src/store/utils'
import { compactQuestionText } from '../../src/renderer/src/lib/transcriptGrouping'
import type { ToolDefinition } from '../../src/shared/types'

// ── 辅助：随机字符串生成器 ───────────────────────────────

function randStr(len: number): string {
  const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!@#$%^&*()_+-=[]{}|;:,.<>?/~`'
  let result = ''
  for (let i = 0; i < len; i++) result += chars[Math.floor(Math.random() * chars.length)]
  return result
}

function randInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min
}

// ── 1. SSRF 防护模糊测试 ─────────────────────────────────

describe('[模糊] SSRF 防护 — 随机 URL', () => {
  const fuzzUrls = [
    '',
    'not-a-url',
    '://',
    'http://',
    'https://',
    'http://0.0.0.0',
    'http://0.0.0.0:8080',
    'http://[::]',
    'http://[::1]:8080',
    'http://[fe80::1]:80/',
    'http://[fc00::1]/',
    'http://[fd00::1]/',
    'http://127.0.0.1:1',
    'http://127.255.255.255:65535',
    'http://10.255.255.255',
    'http://172.16.0.0',
    'http://172.31.255.255',
    'http://192.168.0.0',
    'http://169.254.0.0',
    'http://169.254.169.254',
    'http://metadata.google.internal',
    'http://metadata.azure.com',
    'http://localhost',
    'http://ip6-localhost',
    'http://broadcasthost',
    'file:///etc/passwd',
    'ftp://example.com',
    'javascript:alert(1)',
    'data:text/html,<script>alert(1)</script>',
    'http://' + randStr(1000) + '.com',
    'http://example.com/' + randStr(1000),
    'http://example.com:99999',
    'http://example.com:-1',
    'http://例え.jp',
    'http://example.com/../../etc/passwd',
  ]

  for (const url of fuzzUrls) {
    it(`checkSsrf("${url.slice(0, 60)}") 不崩溃且返回布尔值`, () => {
      const result = checkSsrf(url)
      expect(typeof result.blocked).toBe('boolean')
      if (result.blocked) {
        expect(result.reason).toBeDefined()
      }
    })
  }

  it('1000 次随机 URL 不崩溃', () => {
    for (let i = 0; i < 1000; i++) {
      const url = `http://${randStr(randInt(1, 50))}.com/${randStr(randInt(0, 100))}`
      const result = checkSsrf(url)
      expect(typeof result.blocked).toBe('boolean')
    }
  })
})

// ── 2. 敏感文件检测模糊测试 ───────────────────────────────

describe('[模糊] 敏感文件检测 — 随机路径', () => {
  const fuzzPaths = [
    '',
    '/',
    '/tmp',
    '/home/user/.ssh/id_rsa',
    '/home/user/.ssh/id_rsa.bak',
    '/.env',
    '/.env.production',
    '/project/.env.local',
    '/.npmrc',
    '/.netrc',
    '/_netrc',
    '/credentials.json',
    '/cookies.txt',
    '/server.key',
    '/cert.pem',
    '/cert.pfx',
    '/keystore.jks',
    '/.aws/credentials',
    '/.aws/config',
    '/.docker/config.json',
    '/kube/config',
    '/home/user/.gnupg/pubring.gpg',
    '/home/user/.ssh/config',
    '/tmp/test.txt',
    '/project/src/index.ts',
    '/正常文件.txt',
    '/' + randStr(200),
    '/tmp/' + randStr(100) + '.key',
    '/tmp/' + randStr(100) + '.pem',
  ]

  for (const path of fuzzPaths) {
    it(`checkSensitiveFile("${path.slice(0, 60)}") 不崩溃`, () => {
      const result = checkSensitiveFile(path)
      expect(typeof result.blocked).toBe('boolean')
    })
  }
})

// ── 3. 写入保护模糊测试 ──────────────────────────────────

describe('[模糊] 写入保护 — 随机路径', () => {
  beforeEach(() => {
    setAllowedWriteRoots([])
  })

  it('空白名单时任何路径都允许', () => {
    for (let i = 0; i < 100; i++) {
      const path = '/' + randStr(randInt(1, 100))
      const result = checkWriteAccess(path)
      expect(result.allowed).toBe(true)
    }
  })

  it('白名单设置后边界检测', () => {
    setAllowedWriteRoots(['/tmp/safe'])
    const paths = [
      '/tmp/safe/file.txt',
      '/tmp/safe/sub/dir/file.txt',
      '/tmp/safe',
      '/tmp/unsafe/file.txt',
      '/tmp/saf/file.txt',
      '/etc/passwd',
    ]
    for (const path of paths) {
      const result = checkWriteAccess(path)
      expect(typeof result.allowed).toBe('boolean')
    }
  })
})

// ── 4. 权限系统模糊测试 ──────────────────────────────────

describe('[模糊] 权限系统 — 随机工具名', () => {
  const fuzzToolNames = [
    '',
    'unknown',
    'null',
    'undefined',
    randStr(50),
    randStr(200),
    'file_read\x00',
    'file_read\n',
    'file_read; DROP TABLE--',
    'file_read OR 1=1',
    '../../etc/passwd',
  ]

  for (const name of fuzzToolNames) {
    it(`evaluate(YOLO, "${name.slice(0, 40)}") 返回 allow`, () => {
      expect(evaluate(YOLO_CONFIG, name, '')).toBe('allow')
    })
  }

  it('随机 subject 不影响 evaluate 结果', () => {
    const codingConfig = getConfigForMode('coding')
    for (let i = 0; i < 100; i++) {
      const subject = randStr(randInt(0, 200))
      const result = evaluate(codingConfig, 'file_read', subject)
      expect(['allow', 'ask', 'deny']).toContain(result)
    }
  })
})

// ── 5. normalizeToolSchemas 模糊测试 ──────────────────────

describe('[模糊] normalizeToolSchemas — 随机工具列表', () => {
  it('空数组不崩溃', () => {
    expect(normalizeToolSchemas([])).toEqual([])
  })

  it('100 个随机命名工具排序后仍包含全部', () => {
    const tools: ToolDefinition[] = []
    for (let i = 0; i < 100; i++) {
      tools.push({
        name: randStr(randInt(1, 30)),
        description: randStr(randInt(0, 100)),
        parameters: { type: 'object', properties: {} }
      })
    }
    const sorted = normalizeToolSchemas(tools)
    expect(sorted).toHaveLength(100)
    // 验证有序
    for (let i = 1; i < sorted.length; i++) {
      expect(sorted[i].name >= sorted[i - 1].name).toBe(true)
    }
  })
})

// ── 6. normaliseUsage 模糊测试 ───────────────────────────

describe('[模糊] normaliseUsage — 随机 usage 对象', () => {
  it('undefined 字段不崩溃', () => {
    const result = normaliseUsage({})
    expect(result.promptTokens).toBe(0)
    expect(result.completionTokens).toBe(0)
  })

  it('负数 token 不崩溃', () => {
    const result = normaliseUsage({
      prompt_tokens: -100,
      completion_tokens: -200,
      total_tokens: -300
    })
    expect(result.promptTokens).toBe(-100)
  })

  it('极大 token 值不崩溃', () => {
    const result = normaliseUsage({
      prompt_tokens: Number.MAX_SAFE_INTEGER,
      completion_tokens: Number.MAX_SAFE_INTEGER,
      total_tokens: Number.MAX_SAFE_INTEGER,
      prompt_cache_hit_tokens: Number.MAX_SAFE_INTEGER
    })
    expect(result.promptTokens).toBe(Number.MAX_SAFE_INTEGER)
  })

  it('100 次随机 usage 不崩溃', () => {
    for (let i = 0; i < 100; i++) {
      const result = normaliseUsage({
        prompt_tokens: randInt(0, 100000),
        completion_tokens: randInt(0, 50000),
        total_tokens: randInt(0, 150000),
        prompt_cache_hit_tokens: randInt(0, 100000),
        prompt_cache_miss_tokens: randInt(0, 100000)
      })
      expect(typeof result.totalTokens).toBe('number')
    }
  })
})

// ── 7. ContextManager 模糊测试 ───────────────────────────

describe('[模糊] ContextManager — 极端输入', () => {
  it('contextWindow 为 0 时不崩溃', () => {
    const cm = new ContextManager()
    const result = cm.maybeCompact({
      messages: [],
      config: { maxToolResultChars: 8000, maxContextChars: 300000, recentKeep: 5, snippedKeep: 200, prunedKeep: 80 },
      promptTokens: 999999,
      contextWindow: 0
    })
    expect(result.tier).toBe('none')
  })

  it('promptTokens 为 0 时不崩溃', () => {
    const cm = new ContextManager()
    const result = cm.maybeCompact({
      messages: [],
      config: { maxToolResultChars: 8000, maxContextChars: 300000, recentKeep: 5, snippedKeep: 200, prunedKeep: 80 },
      promptTokens: 0,
      contextWindow: 10000
    })
    expect(result.tier).toBe('none')
  })

  it('负数 token 不崩溃', () => {
    const cm = new ContextManager()
    const result = cm.maybeCompact({
      messages: [],
      config: { maxToolResultChars: 8000, maxContextChars: 300000, recentKeep: 5, snippedKeep: 200, prunedKeep: 80 },
      promptTokens: -100,
      contextWindow: 10000
    })
    expect(result.tier).toBe('none')
  })

  it('compactionRatio = 0 不崩溃', () => {
    const cm = new ContextManager()
    const result = cm.maybeCompact({
      messages: [],
      config: { maxToolResultChars: 8000, maxContextChars: 300000, recentKeep: 5, snippedKeep: 200, prunedKeep: 80 },
      promptTokens: 5000,
      contextWindow: 10000,
      compactionRatio: 0
    })
    expect(typeof result.tier).toBe('string')
  })

  it('100 次随机 token 不崩溃', () => {
    for (let i = 0; i < 100; i++) {
      const cm = new ContextManager()
      cm.maybeCompact({
        messages: [],
        config: { maxToolResultChars: 8000, maxContextChars: 300000, recentKeep: 5, snippedKeep: 200, prunedKeep: 80 },
        promptTokens: randInt(0, 100000),
        contextWindow: randInt(0, 50000)
      })
    }
  })
})

// ── 8. trimContext 模糊测试 ───────────────────────────────

describe('[模糊] trimContext — 空消息/极端长度', () => {
  const config = { maxToolResultChars: 100, maxContextChars: 50, recentKeep: 2, snippedKeep: 10, prunedKeep: 5 }

  it('空数组不崩溃', () => {
    const messages: any[] = []
    trimContext(messages, config)
    expect(messages).toHaveLength(0)
  })

  it('单条消息不崩溃', () => {
    const messages = [{ role: 'user', content: 'hi' }]
    trimContext(messages, config)
    expect(messages).toHaveLength(1)
  })

  it('超长单条消息不崩溃', () => {
    const messages = [{ role: 'user', content: 'X'.repeat(100000) }]
    trimContext(messages, config)
    expect(messages).toHaveLength(1)
  })

  it('所有空 content 不崩溃', () => {
    const messages = [
      { role: 'system', content: '' },
      { role: 'user', content: '' },
      { role: 'assistant', content: '' }
    ]
    trimContext(messages, config)
    expect(messages).toHaveLength(3)
  })
})

// ── 9. genId 模糊测试 ────────────────────────────────────

describe('[模糊] genId — 高频生成', () => {
  it('10000 次连续生成不重复', () => {
    const ids = new Set<string>()
    for (let i = 0; i < 10000; i++) ids.add(genId())
    expect(ids.size).toBe(10000)
  })

  it('结果只含合法字符', () => {
    for (let i = 0; i < 100; i++) {
      const id = genId()
      expect(id).toMatch(/^[a-z0-9]+$/)
    }
  })
})

// ── 10. normalizeAutoMode 模糊测试 ───────────────────────

describe('[模糊] normalizeAutoMode — 非法输入', () => {
  const fuzzValues = [
    null,
    undefined,
    '',
    'invalid',
    'OFF',
    'Off',
    'SAFE',
    'YOLO',
    0,
    1,
    2,
    true,
    false,
    {},
    [],
    NaN,
  ]

  for (const val of fuzzValues) {
    it(`normalizeAutoMode(${JSON.stringify(val)}) 返回 'off'`, () => {
      expect(normalizeAutoMode(val)).toBe('off')
    })
  }
})

// ── 11. normalizeModelId 模糊测试 ─────────────────────────

describe('[模糊] normalizeModelId — 非法输入', () => {
  const fuzzValues = [
    '',
    'invalid-model',
    'deepseek-v4-flash-v2',
    'DEEPSEEK-V4-PRO',
    'a'.repeat(1000),
  ]

  for (const val of fuzzValues) {
    it(`normalizeModelId("${String(val).slice(0, 40)}") 不崩溃`, () => {
      if (!val) {
        expect(normalizeModelId(val as any)).toBeUndefined()
      } else {
        const result = normalizeModelId(val as string)
        expect(typeof result).toBe('string')
      }
    })
  }
})

// ── 12. makeTitle 模糊测试 ───────────────────────────────

describe('[模糊] makeTitle — 极端输入', () => {
  it('空字符串返回"新对话"', () => {
    expect(makeTitle('')).toBe('新对话')
  })

  it('超长字符串被截断', () => {
    const result = makeTitle('a'.repeat(1000))
    expect(result.length).toBeLessThanOrEqual(25)
  })

  it('只有空白字符返回"新对话"', () => {
    expect(makeTitle('   \n\t  ')).toBe('新对话')
  })

  it('特殊字符不崩溃', () => {
    expect(() => makeTitle('!@#$%^&*()')).not.toThrow()
    expect(() => makeTitle('🎉🎊🎈')).not.toThrow()
    expect(() => makeTitle('null\x00')).not.toThrow()
  })
})

// ── 13. compactQuestionText 模糊测试 ─────────────────────

describe('[模糊] compactQuestionText — 极端输入', () => {
  it('空字符串返回空', () => {
    expect(compactQuestionText('')).toBe('')
  })

  it('超长字符串截断到 80', () => {
    expect(compactQuestionText('a'.repeat(500))).toHaveLength(80)
  })

  it('特殊字符不崩溃', () => {
    expect(() => compactQuestionText('\x00\x01\x02')).not.toThrow()
    expect(() => compactQuestionText('🎉🌟✨')).not.toThrow()
  })
})
