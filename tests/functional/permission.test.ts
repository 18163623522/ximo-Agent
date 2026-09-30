/**
 * 功能测试 — 权限系统 (Permission.ts)
 *
 * 测试 allow / ask / deny 决策引擎、glob 匹配、模式配置切换。
 */
import { describe, it, expect } from 'vitest'
import {
  evaluate,
  extractSubject,
  getConfigForMode,
  CODING_DEFAULT_CONFIG,
  OFFICE_DEFAULT_CONFIG,
  SAFE_CONFIG,
  YOLO_CONFIG
} from '../../src/main/Permission'

describe('[功能] 权限决策引擎', () => {
  describe('evaluate — 基本决策', () => {
    it('deny 优先级高于 ask 和 allow', () => {
      const config = {
        allow: [{ tool: 'terminal_exec' }],
        ask: [{ tool: 'terminal_exec' }],
        deny: [{ tool: 'terminal_exec' }],
      }
      expect(evaluate(config, 'terminal_exec', '')).toBe('deny')
    })

    it('ask 优先级高于 allow', () => {
      const config = {
        allow: [{ tool: 'terminal_exec' }],
        ask: [{ tool: 'terminal_exec' }],
        deny: [],
      }
      expect(evaluate(config, 'terminal_exec', '')).toBe('ask')
    })

    it('未匹配规则时使用 defaultDecision', () => {
      expect(YOLO_CONFIG.defaultDecision).toBe('allow')
      expect(evaluate(YOLO_CONFIG, 'unknown_tool', '')).toBe('allow')
    })

    it('无 defaultDecision 时默认 ask', () => {
      const config = { allow: [], ask: [], deny: [] }
      expect(evaluate(config, 'unknown_tool', '')).toBe('ask')
    })
  })

  describe('CODING 模式权限', () => {
    it('只读工具 allow', () => {
      for (const tool of ['file_read', 'file_list', 'file_search', 'web_search', 'code_lint']) {
        expect(evaluate(CODING_DEFAULT_CONFIG, tool, '')).toBe('allow')
      }
    })

    it('写操作 allow（有 checkpoint 保障）', () => {
      for (const tool of ['file_write', 'file_edit', 'multi_edit', 'move_file']) {
        expect(evaluate(CODING_DEFAULT_CONFIG, tool, '')).toBe('allow')
      }
    })

    it('危险操作 ask', () => {
      expect(evaluate(CODING_DEFAULT_CONFIG, 'terminal_exec', 'rm -rf /')).toBe('ask')
      expect(evaluate(CODING_DEFAULT_CONFIG, 'git_operations', 'push --force')).toBe('ask')
      expect(evaluate(CODING_DEFAULT_CONFIG, 'file_delete', '/important')).toBe('ask')
    })

    it('禁止操作 deny', () => {
      expect(evaluate(CODING_DEFAULT_CONFIG, 'act_ui', '')).toBe('deny')
      expect(evaluate(CODING_DEFAULT_CONFIG, 'network_replay', '')).toBe('deny')
      expect(evaluate(CODING_DEFAULT_CONFIG, 'browser_execute_js', '')).toBe('deny')
    })
  })

  describe('OFFICE 模式权限', () => {
    it('联网工具 allow', () => {
      expect(evaluate(OFFICE_DEFAULT_CONFIG, 'web_search', '')).toBe('allow')
      expect(evaluate(OFFICE_DEFAULT_CONFIG, 'web_fetch', '')).toBe('allow')
    })

    it('写操作 ask', () => {
      expect(evaluate(OFFICE_DEFAULT_CONFIG, 'file_write', '')).toBe('ask')
      expect(evaluate(OFFICE_DEFAULT_CONFIG, 'file_edit', '')).toBe('ask')
    })

    it('无 deny 列表', () => {
      expect(OFFICE_DEFAULT_CONFIG.deny).toHaveLength(0)
    })
  })

  describe('SAFE 模式权限', () => {
    it('默认 allow（defaultDecision）', () => {
      expect(evaluate(SAFE_CONFIG, 'file_read', '')).toBe('allow')
      expect(evaluate(SAFE_CONFIG, 'file_write', '')).toBe('allow')
      expect(evaluate(SAFE_CONFIG, 'terminal_exec', 'ls') ).toBe('allow')
    })

    it('file_delete 仍需 ask', () => {
      expect(evaluate(SAFE_CONFIG, 'file_delete', '/tmp')).toBe('ask')
    })

    it('系统级操作 deny', () => {
      expect(evaluate(SAFE_CONFIG, 'act_ui', '')).toBe('deny')
      expect(evaluate(SAFE_CONFIG, 'network_replay', '')).toBe('deny')
    })
  })

  describe('extractSubject', () => {
    it('terminal_exec 提取 command', () => {
      expect(extractSubject('terminal_exec', { command: 'npm test' })).toBe('npm test')
    })

    it('git_operations 提取 action', () => {
      expect(extractSubject('git_operations', { action: 'commit' })).toBe('commit')
    })

    it('file_delete 提取 filePath', () => {
      expect(extractSubject('file_delete', { filePath: '/tmp/x' })).toBe('/tmp/x')
    })

    it('未知工具返回空字符串', () => {
      expect(extractSubject('unknown', { foo: 'bar' })).toBe('')
    })
  })

  describe('getConfigForMode', () => {
    it('coding → CODING_DEFAULT_CONFIG', () => {
      expect(getConfigForMode('coding')).toBe(CODING_DEFAULT_CONFIG)
    })

    it('office → OFFICE_DEFAULT_CONFIG', () => {
      expect(getConfigForMode('office')).toBe(OFFICE_DEFAULT_CONFIG)
    })

    it('design → OFFICE_DEFAULT_CONFIG（共用）', () => {
      expect(getConfigForMode('design')).toBe(OFFICE_DEFAULT_CONFIG)
    })

    it('未知模式 → CODING_DEFAULT_CONFIG（默认）', () => {
      expect(getConfigForMode('unknown')).toBe(CODING_DEFAULT_CONFIG)
    })
  })
})
