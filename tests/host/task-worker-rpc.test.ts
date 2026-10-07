/**
 * ProxyDesktopBus 单测（阶段 D2 防线）
 *
 * 防的是真机踩过的坑：worker 侧桌面 RPC 的应答处理器未接线时，
 * dispatch 会静默挂到 30s 超时——上层表现为 desktop 工具连续失败，
 * 但错误信息（"RPC 超时"）不指向真正的接线疏漏。
 *
 * 本测试直接驱动 RPC 语义：发请求 → 回灌应答 → 断言 resolve/reject 与
 * 未知 reqId 不崩。
 */
import { describe, it, expect, vi } from 'vitest'

// task-worker 的 import 链经 task-runner → tool-execution → SkillStore → paths
// 间接依赖 electron（vitest 无 shim）；按仓库既有惯例 mock 掉
vi.mock('electron', () => ({
  app: { getPath: (): string => '/tmp/ximo-test', getName: (): string => 'ximo-host' },
  safeStorage: { isEncryptionAvailable: (): boolean => false },
}))

import { ProxyDesktopBus } from '../../src/host/agent/task-worker'

describe('ProxyDesktopBus — worker 侧桌面 RPC 客户端', () => {
  it('dispatch 发出 desktop 请求，应答回灌后 resolve data', async () => {
    const sent: { t: string; reqId: string; action: string }[] = []
    const bus = new ProxyDesktopBus((m) => sent.push(m as { t: string; reqId: string; action: string }))

    const p = bus.dispatch('window.list', {})
    expect(sent).toHaveLength(1)
    expect(sent[0].t).toBe('desktop')
    expect(sent[0].action).toBe('window.list')

    bus.handleReply({ reqId: sent[0].reqId, ok: true, data: [{ id: '0x1' }] })
    await expect(p).resolves.toEqual([{ id: '0x1' }])
    expect(bus.pendingCount).toBe(0)
  })

  it('应答 ok:false 时 reject 带 error（而非静默挂起）', async () => {
    const sent: { reqId: string }[] = []
    const bus = new ProxyDesktopBus((m) => sent.push(m as { reqId: string }))
    const p = bus.dispatch('screen.snapshot', {})
    bus.handleReply({ reqId: sent[0].reqId, ok: false, error: '截图失败（桌面会话未就绪）' })
    await expect(p).rejects.toThrow('截图失败（桌面会话未就绪）')
  })

  it('未知 reqId 的应答被忽略且不抛错（父侧重发/迟到应答不污染）', () => {
    const bus = new ProxyDesktopBus(() => {})
    expect(() => bus.handleReply({ reqId: 'nope', ok: true, data: 1 })).not.toThrow()
    expect(bus.pendingCount).toBe(0)
  })
})
