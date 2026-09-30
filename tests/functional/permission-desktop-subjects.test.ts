/**
 * 回归测试 — wsl_desktop 权限条目决策矩阵
 *
 * 锁定 Permission.ts 中 wsl_desktop 按 subject 细分的当前行为：
 * 交互类 action 一律 allow（历史上 scroll/paste/window_list 曾漏枚举落 ask，弹确认框）；
 * exec/launch/set_resolution 属重操作走 ask；SAFE/YOLO 的回退语义一并列锁。
 * 改动 Permission.ts 的 wsl_desktop 条目前先改这里。
 */
import { describe, it, expect } from 'vitest'
import { evaluate, extractSubject, getConfigForMode, SAFE_CONFIG, YOLO_CONFIG } from '../../src/main/Permission'

const INTERACTIVE_SUBJECTS = [
  'screenshot', 'click', 'double_click', 'mouse_move', 'drag', 'scroll',
  'key_press', 'key_down', 'key_up', 'type', 'paste',
  'clipboard_read', 'window_list', 'window_op'
] as const

const HEAVY_SUBJECTS = ['exec', 'launch', 'set_resolution'] as const

describe('回归：wsl_desktop 权限条目（本轮新增 drag/scroll/paste 等补全）', () => {
  it('coding 模式 — 全部交互类 action allow（历史缺口：scroll/paste/window_list 曾落 ask）', () => {
    const config = getConfigForMode('coding')
    for (const subject of INTERACTIVE_SUBJECTS) {
      expect(evaluate(config, 'wsl_desktop', subject), `coding/${subject}`).toBe('allow')
    }
  })

  it('office 模式 — 全部交互类 action allow', () => {
    const config = getConfigForMode('office')
    for (const subject of INTERACTIVE_SUBJECTS) {
      expect(evaluate(config, 'wsl_desktop', subject), `office/${subject}`).toBe('allow')
    }
  })

  it('coding/office 模式 — exec/launch/set_resolution 需要 ask（等同 terminal_exec 审批级别）', () => {
    for (const mode of ['coding', 'office']) {
      const config = getConfigForMode(mode)
      for (const subject of HEAVY_SUBJECTS) {
        expect(evaluate(config, 'wsl_desktop', subject), `${mode}/${subject}`).toBe('ask')
      }
    }
  })

  it('coding/office 未枚举的 action 回退为 ask（defaultDecision 未配置 → 保守询问）', () => {
    for (const mode of ['coding', 'office']) {
      expect(evaluate(getConfigForMode(mode), 'wsl_desktop', 'hover')).toBe('ask')
    }
  })

  it('safe 模式 — 交互类走 defaultDecision allow，仅 exec/launch/set_resolution ask', () => {
    for (const subject of INTERACTIVE_SUBJECTS) {
      expect(evaluate(SAFE_CONFIG, 'wsl_desktop', subject), `safe/${subject}`).toBe('allow')
    }
    for (const subject of HEAVY_SUBJECTS) {
      expect(evaluate(SAFE_CONFIG, 'wsl_desktop', subject), `safe/${subject}`).toBe('ask')
    }
  })

  it('yolo 模式 — wsl_desktop 一律 allow', () => {
    for (const subject of [...INTERACTIVE_SUBJECTS, ...HEAVY_SUBJECTS]) {
      expect(evaluate(YOLO_CONFIG, 'wsl_desktop', subject), `yolo/${subject}`).toBe('allow')
    }
  })

  it('extractSubject 对 wsl_desktop 取 action 参数 — 无 action 返回空串', () => {
    expect(extractSubject('wsl_desktop', { action: 'drag' })).toBe('drag')
    expect(extractSubject('wsl_desktop', {})).toBe('')
  })

  it('deny 优先级不受新增 allow 条目影响 — coding 模式 act_ui 仍被拒', () => {
    const config = getConfigForMode('coding')
    expect(evaluate(config, 'act_ui', '')).toBe('deny')
    expect(evaluate(config, 'browser_execute_js', '')).toBe('deny')
    expect(evaluate(config, 'network_replay', '')).toBe('deny')
  })
})
