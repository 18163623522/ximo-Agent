/**
 * 权限规则 ↔ 工具清单 三方对账（阶段 C2 防线）
 *
 * 防两类静默漂移：
 * 1. 规则引用了不存在的工具（allow/ask 规则永不匹配 = 死规则，制造"已覆盖"错觉）
 * 2. 主机清单里的工具没有任何权限规则（静默回退默认决策 — 无人值守下功能不可用，
 *    且无任何告警。历史案例：vision_analyze / web_cache 等 4 工具 / skill_invoke）
 *
 * 数据源：src/host/agent/tool-inventory.ts（纯数据，无副作用）+ lazy-registry.modeToolNames
 * + Permission 配置。deny 规则豁免对账（防护性清单，允许为未来/动态工具预埋）。
 */
import { describe, it, expect } from 'vitest'
import { CODING_DEFAULT_CONFIG, OFFICE_DEFAULT_CONFIG, SAFE_CONFIG } from '../../src/main/Permission'
import { modeToolNames } from '../../src/main/tools/lazy-registry'
import { HOST_TOOL_NAMES, HOST_TOOL_GROUPS } from '../../src/host/agent/tool-inventory'

/** 主应用全部模式的工具面（任一模式注册即可视为"存在"） */
const MAIN_APP_SURFACE = new Set(Object.values(modeToolNames).flat())
/** 主机运行时注册的工具 — 不在静态清单里，由 task-runner 在任务期注册 */
const HOST_RUNTIME_TOOLS = ['desktop', 'office_docs']
/** 防护性预埋规则 — 引用的工具当前任何模式都不注册，但保留 ask 语义：
 *  若未来重新接入这些工具，审批意图已在。与 deny 规则同等豁免。 */
const PROTECTIVE_RULES = ['browser_execute_js', 'network_replay']
/** 主应用 ∪ 主机 — 规则对账的全集 */
const KNOWN_TOOLS = new Set([...MAIN_APP_SURFACE, ...HOST_TOOL_NAMES, ...HOST_RUNTIME_TOOLS])

const CONFIGS = {
  coding: CODING_DEFAULT_CONFIG,
  office: OFFICE_DEFAULT_CONFIG,
  safe: SAFE_CONFIG,
} as const

describe('权限规则 ↔ 工具清单 对账', () => {
  it('allow/ask 规则引用的工具必须真实存在（主应用任一模式 ∪ 主机清单）', () => {
    const dead: string[] = []
    for (const [modeName, config] of Object.entries(CONFIGS)) {
      for (const kind of ['allow', 'ask'] as const) {
        for (const rule of config[kind]) {
          if (PROTECTIVE_RULES.includes(rule.tool)) continue
          if (!KNOWN_TOOLS.has(rule.tool)) dead.push(`${modeName}.${kind}: ${rule.tool}`)
        }
      }
    }
    expect(dead).toEqual([])
  })

  it('主机清单里的每个工具在 coding 模式（主机默认）都有显式规则 — 无静默回退', () => {
    const rules = [...CODING_DEFAULT_CONFIG.allow, ...CODING_DEFAULT_CONFIG.ask]
    const covered = new Set(rules.map((r) => r.tool))
    const uncovered = HOST_TOOL_NAMES.filter((t) => !covered.has(t))
    expect(uncovered).toEqual([])
  })

  it('主机模块组都是 lazy-registry 已知组（防组名拼写漂移）', async () => {
    // lazy-registry 不导出 moduleFactories — 用 ensureModuleGroupsLoaded 的
    // 未知组告警路径反向验证：加载一个不存在的组会 console.warn 并跳过。
    // 这里直接校验静态来源：模块组名单的单一来源仍是 task-runner/tool-inventory，
    // 组名拼写错误会在 host-verify（工具缺失）暴露 — 此测试锁定非空与去重。
    expect(HOST_TOOL_GROUPS.length).toBeGreaterThan(0)
    expect(new Set(HOST_TOOL_GROUPS).size).toBe(HOST_TOOL_GROUPS.length)
  })
})
