/**
 * InstanceRegistry — Agent 实例注册表（instances 的持有与持久化）
 *
 * 加载时把上次会话遗留的 running/queued 标记为中断；
 * 保存时 running 排前、按开始时间倒序，超出保留上限只裁剪已结束的记录。
 */

// -----------------------------------------------------------------------
// 实例注册表
// -----------------------------------------------------------------------

import { readFile, writeFile } from 'fs/promises'
import { agentInstancesFile } from '../paths'
import type { AgentInstance } from '@shared/agent-definition'

const MAX_INSTANCE_RECORDS = 50

export class InstanceRegistry {
  instances: AgentInstance[] = []
  private instancesLoaded = false

  async loadInstances(): Promise<void> {
    if (this.instancesLoaded) return
    try {
      const raw = await readFile(agentInstancesFile, 'utf-8')
      const parsed = JSON.parse(raw)
      if (Array.isArray(parsed)) {
        this.instances = parsed
        // 上次会话遗留的 running/queued 标记为中断
        for (const ins of this.instances) {
          if (ins.status === 'running' || ins.status === 'queued') {
            ins.status = 'error'
            ins.error = '应用退出导致执行中断'
            ins.finishedAt = ins.startedAt
          }
        }
      }
    } catch { /* 首次无文件 */ }
    this.instancesLoaded = true
  }

  async saveInstances(): Promise<void> {
    // running 的排前面，再按开始时间倒序；超出保留条数的只裁剪已结束的
    this.instances.sort((a, b) => {
      if ((a.status === 'running') !== (b.status === 'running')) return a.status === 'running' ? -1 : 1
      return b.startedAt - a.startedAt
    })
    if (this.instances.length > MAX_INSTANCE_RECORDS) {
      const running = this.instances.filter((i) => i.status === 'running')
      const ended = this.instances.filter((i) => i.status !== 'running').slice(0, MAX_INSTANCE_RECORDS - running.length)
      this.instances = [...running, ...ended]
    }
    await writeFile(agentInstancesFile, JSON.stringify(this.instances, null, 2), 'utf-8').catch(() => {})
  }

  async listInstances(): Promise<AgentInstance[]> {
    await this.loadInstances()
    return [...this.instances]
  }
}
