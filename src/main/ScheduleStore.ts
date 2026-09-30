/**
 * ScheduleStore — Agent 定时任务持久化 + 调度器
 *
 * 任务到点后主进程直派 AgentSystemStore.startInstance（不依赖渲染层存活）。
 * 支持全局暂停（会议/演示模式）与错过补跑（应用未运行错过时刻后启动时补执行）。
 */
import { readFile, writeFile } from 'fs/promises'
import { schedulesFile } from './paths'
import type { AgentSchedule, ScheduleDraft } from '@shared/agent-schedule'
import { normalizeScheduleDraft } from '@shared/agent-schedule'

const TICK_MS = 30_000

/** schedules.json 存储结构（旧版为裸数组，加载时迁移） */
interface ScheduleFile {
  paused: boolean
  schedules: AgentSchedule[]
}

class ScheduleStoreImpl {
  private schedules: AgentSchedule[] = []
  private paused = false
  private loaded = false
  private timer: NodeJS.Timeout | null = null

  private async load(): Promise<void> {
    if (this.loaded) return
    try {
      const raw = await readFile(schedulesFile, 'utf-8')
      const parsed = JSON.parse(raw) as ScheduleFile | AgentSchedule[]
      if (Array.isArray(parsed)) {
        // 旧版格式迁移
        this.schedules = parsed
      } else if (parsed && Array.isArray(parsed.schedules)) {
        this.schedules = parsed.schedules
        this.paused = !!parsed.paused
      }
    } catch { /* 首次无文件 */ }
    this.loaded = true
  }

  private async save(): Promise<void> {
    const data: ScheduleFile = { paused: this.paused, schedules: this.schedules }
    try {
      await writeFile(schedulesFile, JSON.stringify(data, null, 2), 'utf-8')
    } catch { /* 持久化失败不阻断调度 */ }
  }

  async list(): Promise<AgentSchedule[]> {
    await this.load()
    return [...this.schedules].sort((a, b) => b.createdAt - a.createdAt)
  }

  async isPaused(): Promise<boolean> {
    await this.load()
    return this.paused
  }

  async setPaused(paused: boolean): Promise<void> {
    await this.load()
    this.paused = paused
    await this.save()
  }

  async create(draft: ScheduleDraft): Promise<AgentSchedule | null> {
    await this.load()
    const schedule = normalizeScheduleDraft(draft)
    if (!schedule) return null
    schedule.id = `sch_${Date.now()}_${Math.floor(Math.random() * 1000)}`
    this.schedules.push(schedule)
    await this.save()
    return schedule
  }

  async update(id: string, draft: ScheduleDraft): Promise<AgentSchedule | null> {
    await this.load()
    const existing = this.schedules.find((s) => s.id === id)
    if (!existing) return null
    const next = normalizeScheduleDraft(draft, existing)
    if (!next) return null
    this.schedules = this.schedules.map((s) => (s.id === id ? next : s))
    await this.save()
    return next
  }

  async remove(id: string): Promise<void> {
    await this.load()
    this.schedules = this.schedules.filter((s) => s.id !== id)
    await this.save()
  }

  /** 启动调度器 — 应用运行期间每 30s 检查一次到期任务 */
  startScheduler(): void {
    if (this.timer) return
    this.timer = setInterval(() => { void this.tick() }, TICK_MS)
  }

  private async tick(): Promise<void> {
    await this.load()
    if (this.paused) return
    const now = Date.now()
    let changed = false
    for (const s of this.schedules) {
      if (!s.enabled) continue
      const due = this.isDue(s, now)
      if (!due) continue
      changed = true
      s.lastRunAt = now
      s.lastRunStatus = 'fired'
      s.lastRunMessage = due === 'catchup' ? '错过补跑' : '已触发'
      this.fire(s)
    }
    if (changed) await this.save()
  }

  /** 到期判定 — 返回 'normal' | 'catchup' | false
   *  interval 按上次触发时间（应用重启后过期即补，天然支持补跑）；
   *  daily/weekly 常规在时刻后 2 分钟窗口内命中且当天未触发；
   *  勾选错过补跑时，当天时刻已过但未触发的也补执行 */
  private isDue(s: AgentSchedule, now: number): 'normal' | 'catchup' | false {
    if (s.kind === 'interval') {
      const base = s.lastRunAt ?? s.createdAt
      return now - base >= (s.intervalMinutes ?? 0) * 60_000 && 'normal'
    }
    const d = new Date(now)
    if (s.kind === 'weekly' && !(s.weekdays ?? []).includes(d.getDay())) return false
    const [h, m] = (s.time ?? '00:00').split(':').map(Number)
    const scheduledToday = new Date(d.getFullYear(), d.getMonth(), d.getDate(), h, m).getTime()
    // 当天已触发过则不重复
    if (s.lastRunAt && new Date(s.lastRunAt).toDateString() === d.toDateString()) return false
    // 常规窗口：时刻后 2 分钟内
    if (now >= scheduledToday && now - scheduledToday < 120_000) return 'normal'
    // 错过补跑：时刻已过、当天未触发
    if (s.catchUp && now > scheduledToday) return 'catchup'
    return false
  }

  /** 触发 — 直接派发给 Agent 实例引擎（主进程内闭环，不依赖渲染层存活） */
  private fire(s: AgentSchedule): void {
    void (async () => {
      try {
        const { agentSystemStore } = await import('./AgentSystemStore')
        const res = await agentSystemStore.startInstance({
          agentId: s.agentId,
          task: s.prompt,
          source: { scheduleId: s.id, scheduleName: s.name },
        })
        if (!res.success) {
          s.lastRunStatus = 'skipped'
          s.lastRunMessage = res.message ?? '触发失败'
          await this.save()
        }
      } catch (e) {
        s.lastRunStatus = 'error'
        s.lastRunMessage = (e as Error).message.slice(0, 200)
        await this.save()
      }
    })()
  }
}

export const scheduleStore = new ScheduleStoreImpl()
