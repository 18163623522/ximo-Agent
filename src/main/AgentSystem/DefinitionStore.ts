/**
 * DefinitionStore — Agent 定义库（definitions 的持有与持久化 CRUD）
 *
 * 首次访问时从 agentDefinitionsFile 加载；文件缺失/为空则回填 seedDefinitions；
 * 删除后若清空同样回填种子定义。
 */

// -----------------------------------------------------------------------
// Agent 定义 CRUD
// -----------------------------------------------------------------------

import { readFile, writeFile } from 'fs/promises'
import { agentDefinitionsFile } from '../paths'
import type { AgentDefinition } from '@shared/agent-definition'
import { seedDefinitions } from '@shared/agent-definition'
import { genId } from './gen-id'

export class DefinitionStore {
  definitions: AgentDefinition[] = []
  private defsLoaded = false

  async loadDefinitions(): Promise<void> {
    if (this.defsLoaded) return
    try {
      const raw = await readFile(agentDefinitionsFile, 'utf-8')
      const parsed = JSON.parse(raw)
      if (Array.isArray(parsed) && parsed.length > 0) {
        this.definitions = parsed
      } else {
        this.definitions = seedDefinitions()
        await this.saveDefinitions()
      }
    } catch {
      this.definitions = seedDefinitions()
      await this.saveDefinitions().catch(() => {})
    }
    this.defsLoaded = true
  }

  private async saveDefinitions(): Promise<void> {
    await writeFile(agentDefinitionsFile, JSON.stringify(this.definitions, null, 2), 'utf-8')
  }

  async listDefinitions(): Promise<AgentDefinition[]> {
    await this.loadDefinitions()
    return [...this.definitions]
  }

  async createDefinition(draft: Omit<AgentDefinition, 'id'>): Promise<AgentDefinition | null> {
    await this.loadDefinitions()
    if (!draft.name.trim()) return null
    const def: AgentDefinition = {
      ...draft,
      id: genId('agent'),
      emoji: draft.emoji || '🤖',
      name: draft.name.trim(),
    }
    this.definitions.push(def)
    await this.saveDefinitions()
    return def
  }

  async updateDefinition(id: string, patch: Omit<AgentDefinition, 'id'>): Promise<AgentDefinition | null> {
    await this.loadDefinitions()
    if (!patch.name.trim()) return null
    const idx = this.definitions.findIndex((d) => d.id === id)
    if (idx === -1) return null
    this.definitions[idx] = { ...patch, id, emoji: patch.emoji || '🤖', name: patch.name.trim() }
    await this.saveDefinitions()
    return this.definitions[idx]
  }

  async deleteDefinition(id: string): Promise<void> {
    await this.loadDefinitions()
    this.definitions = this.definitions.filter((d) => d.id !== id)
    if (this.definitions.length === 0) this.definitions = seedDefinitions()
    await this.saveDefinitions()
  }
}
