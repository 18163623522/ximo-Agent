// ── buildApiMessages 的可变缓存（单一状态模块）─────────────────────────
// 集中承载模块级可变状态：导入技能缓存 + 模式记忆缓存。
// 其余拆分模块（systemPrompt / history）保持无状态纯函数。

import type { ImportedSkill, Mode } from '@shared/types'

// ── 导入技能缓存 — 避免每次发消息都通过 IPC 从磁盘读取 ──
// 带 TTL：技能列表变更后即使忘记调用 invalidateImportedSkillsCache，
// 缓存也会在 SKILL_CACHE_TTL 后自动过期，避免跨会话陈旧。
let _importedSkillsCache: ImportedSkill[] | null = null
let _importedSkillsCacheTime = 0
const SKILL_CACHE_TTL = 5 * 60 * 1000 // 5 分钟

/** 获取导入技能列表（带缓存 + TTL 过期） */
export async function getImportedSkills(): Promise<ImportedSkill[]> {
  if (_importedSkillsCache !== null && Date.now() - _importedSkillsCacheTime < SKILL_CACHE_TTL) {
    return _importedSkillsCache
  }
  _importedSkillsCache = await window.api.importedSkills.load()
  _importedSkillsCacheTime = Date.now()
  return _importedSkillsCache
}

/** 使导入技能缓存失效 — 在技能列表变更后调用 */
export function invalidateImportedSkillsCache(): void {
  _importedSkillsCache = null
  _importedSkillsCacheTime = 0
}

// ── 模式记忆缓存 — 避免每次发消息都通过 IPC 从磁盘读取 ──
// memory_update 工具更新记忆后，会通过 IPC 通知渲染进程使此缓存失效。
// 带 TTL 兜底：即使通知丢失，缓存也会在 MEMORY_CACHE_TTL 后过期。
const _memoryCache = new Map<string, { content: string; time: number }>()
const MEMORY_CACHE_TTL = 60 * 1000 // 1 分钟

/** 使指定模式的记忆缓存失效 — memory_update 后调用 */
export function invalidateMemoryCache(mode?: string): void {
  if (mode) {
    _memoryCache.delete(mode)
  } else {
    _memoryCache.clear()
  }
}

/** 加载模式记忆（带缓存 + TTL 兜底）— 加载失败返回空串，不阻塞对话 */
export async function loadModeMemory(mode: Mode): Promise<string> {
  let memoryContent = ''
  const modeKey = mode as string
  const cached = _memoryCache.get(modeKey)
  if (cached && Date.now() - cached.time < MEMORY_CACHE_TTL) {
    memoryContent = cached.content
  } else {
    try {
      const raw = await window.api.memory.load(mode)
      memoryContent = raw.trim()
      _memoryCache.set(modeKey, { content: memoryContent, time: Date.now() })
    } catch { /* 记忆加载失败不应阻塞对话 */ }
  }
  return memoryContent
}
