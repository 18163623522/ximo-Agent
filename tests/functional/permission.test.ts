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

    it('视觉分析 allow（只读读图，与 file_read/web_fetch 同级）', () => {
      // 回归：vision_analyze 此前未列入任何配置 → 回退 defaultDecision（coding 下为
      // undefined）→ 保守 ask。只读工具被判 ask 会让读图也弹审批，主机侧更会
      // fail-closed 直接拒绝（无审批渠道）导致视觉回路断裂。
      for (const cfg of [CODING_DEFAULT_CONFIG, OFFICE_DEFAULT_CONFIG]) {
        expect(evaluate(cfg, 'vision_analyze', '')).toBe('allow')
      }
    })

    it('无外部副作用的工具 allow（无人值守主机不受影响）', () => {
      // 回归：这些工具写的是自有数据目录（缓存/记忆/技能），此前未列入 allow →
      // 回退 ask。主机无人值守 = fail-closed，等于给 Agent 挂了 4 个永远失败的工具。
      for (const t of ['web_cache', 'web_research', 'memory_update', 'skill_invoke']) {
        for (const cfg of [CODING_DEFAULT_CONFIG, OFFICE_DEFAULT_CONFIG]) {
          expect(evaluate(cfg, t, ''), `${t} 在配置中应为 allow`).toBe('allow')
        }
      }
      // 对照：真正有副作用的仍须审批，不得一并放开
      expect(evaluate(CODING_DEFAULT_CONFIG, 'terminal_exec', '')).toBe('ask')
      expect(evaluate(CODING_DEFAULT_CONFIG, 'file_delete', '')).toBe('ask')
      expect(evaluate(CODING_DEFAULT_CONFIG, 'code_execute', '')).toBe('ask')
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
