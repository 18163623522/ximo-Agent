/**
 * 功能 + 集成测试 — AssistWatcher 工作分摊感知器全链路
 *
 * 流程：定时感知（listRoots + look 文本大纲）→ LLM 分析（严格 JSON）→
 * 频控（同签名 30min 不重复）→ 弹窗征求（agent-assist:proposal）→
 * 用户响应 → 派发 agentSystemStore.startInstance。
 * 重点验证安全语义：fail-closed（无窗口不提议）、超时视为忽略、拒绝/接受都进频控。
 * 外部依赖（PiBridge / 子 Agent / AgentSystemStore / store）全部打桩，fake timers 驱动。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const m = vi.hoisted(() => ({
  command: vi.fn(),
  callSubAgent: vi.fn(),
  startInstance: vi.fn(),
  loadSettings: vi.fn(),
  saveSettings: vi.fn(),
  loadConversations: vi.fn(),
  webContentsSend: vi.fn(),
  getAllWindows: vi.fn(),
}))

vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: m.getAllWindows },
  Notification: { isSupported: () => false },
}))
vi.mock('../../src/main/tools/ComputerUse/PiBridge', () => ({
  piBridge: { command: m.command },
}))
vi.mock('../../src/main/tools/ComputerUse/outline-formatters', () => ({
  formatOutlineCompact: () => '前台内容摘要（打桩）',
  formatOutlineFull: () => '前台内容全文（打桩）',
}))
vi.mock('../../src/main/tools/Skill/sub-agent', () => ({
  callSubAgentWithTools: m.callSubAgent,
}))
vi.mock('../../src/main/AgentSystemStore', () => ({
  agentSystemStore: { startInstance: m.startInstance },
}))
vi.mock('../../src/main/store', () => ({
  loadSettings: m.loadSettings,
  saveSettings: m.saveSettings,
  loadConversations: m.loadConversations,
}))
vi.mock('../../src/main/deepseek/provider', () => ({
  resolveActiveProvider: (s: { apiKey?: string; baseUrl?: string }) => ({
    apiKey: s.apiKey ?? '', baseUrl: s.baseUrl ?? '',
  }),
}))

const VERDICT_HELP = JSON.stringify({
  shouldHelp: true,
  title: '整理季度报告数据',
  observation: 'Excel 中正在编辑季度报告',
  proposedTask: '帮用户整理季度报告数据并生成汇总表',
})

function fakeWindow(): { isDestroyed: () => boolean; webContents: { send: typeof m.webContentsSend } } {
  return { isDestroyed: () => false, webContents: { send: m.webContentsSend } }
}

async function freshSut() {
  vi.resetModules()
  const mod = await import('../../src/main/AssistWatcher')
  activeSut = mod.assistWatcher
  return activeSut
}

// 跨测试隔离：AssistWatcher 是带定时器的单例，afterEach 必须停表，
// 否则上一用例的 interval 会在下一用例的 fake 时间轴上继续触发（污染计数）
let activeSut: Awaited<ReturnType<typeof freshSut>> | null = null

beforeEach(() => {
  vi.useFakeTimers()
  vi.clearAllMocks() // mock 调用计数必须按用例清零，否则上一用例的 startInstance 计入本用例断言
  m.getAllWindows.mockReturnValue([fakeWindow()])
  m.command.mockResolvedValue({ roots: [{ title: '季度报告.xlsx - Excel' }] })
  m.callSubAgent.mockResolvedValue(VERDICT_HELP)
  m.startInstance.mockResolvedValue({ success: true, instance: { id: 'ins_1' } })
  m.loadSettings.mockResolvedValue({ apiKey: 'test-key', baseUrl: 'https://x/v1', model: 'm', reasoningEffort: 'high', assistWatchEnabled: false })
  m.loadConversations.mockResolvedValue([])
  m.webContentsSend.mockClear()
})

afterEach(async () => {
  if (activeSut) {
    await activeSut.setEnabled(false)
    activeSut = null
  }
  vi.useRealTimers()
})

describe('AssistWatcher — 工作分摊全链路', () => {
  it('接受流：感知 → 分析 → 弹窗 → 用户同意 → 派发后台实例（带 assist-watcher 来源标记）', async () => {
    const sut = await freshSut()
    await sut.setEnabled(true)
    expect(m.saveSettings).toHaveBeenCalledWith(expect.objectContaining({ assistWatchEnabled: true }))

    await vi.advanceTimersByTimeAsync(45_001) // 越过首次检查延迟

    // 感知调用了 listRoots + look 两个命令
    expect(m.command).toHaveBeenCalledTimes(2)
    // 弹窗推送到渲染层
    expect(m.webContentsSend).toHaveBeenCalledWith('agent-assist:proposal', expect.objectContaining({
      title: '整理季度报告数据',
      observation: 'Excel 中正在编辑季度报告',
      proposedTask: '帮用户整理季度报告数据并生成汇总表',
    }))

    const proposal = m.webContentsSend.mock.calls.at(-1)![1] as { id: string }
    sut.respondProposal(proposal.id, true)
    await vi.advanceTimersByTimeAsync(1)

    expect(m.startInstance).toHaveBeenCalledTimes(1)
    expect(m.startInstance).toHaveBeenCalledWith(expect.objectContaining({
      task: '帮用户整理季度报告数据并生成汇总表',
      source: expect.objectContaining({ scheduleId: 'assist-watcher', scheduleName: '工作分摊' }),
    }))
  })

  it('拒绝流：不接受 → 不派发，且同签名 30 分钟内不重复提议（不再调 LLM）', async () => {
    const sut = await freshSut()
    await sut.setEnabled(true)
    await vi.advanceTimersByTimeAsync(45_001)

    const proposal = m.webContentsSend.mock.calls.at(-1)![1] as { id: string }
    sut.respondProposal(proposal.id, false)
    await vi.advanceTimersByTimeAsync(1)
    expect(m.startInstance).not.toHaveBeenCalled()
    expect(m.callSubAgent).toHaveBeenCalledTimes(1)

    // 10 分钟后下一轮：相同感知 → 频控命中，不再分析不弹窗
    await vi.advanceTimersByTimeAsync(10 * 60_000)
    expect(m.callSubAgent).toHaveBeenCalledTimes(1)
    expect(m.webContentsSend).toHaveBeenCalledTimes(1)
  })

  it('fail-closed：无渲染窗口（无弹窗渠道）→ 不感知不分析不提议', async () => {
    m.getAllWindows.mockReturnValue([])
    const sut = await freshSut()
    await sut.setEnabled(true)
    await vi.advanceTimersByTimeAsync(45_001 + 10 * 60_000)
    expect(m.command).not.toHaveBeenCalled()
    expect(m.callSubAgent).not.toHaveBeenCalled()
    expect(m.webContentsSend).not.toHaveBeenCalled()
  })

  it('提议超时（120s 无响应）→ 视为忽略：不派发且进入频控', async () => {
    const sut = await freshSut()
    await sut.setEnabled(true)
    await vi.advanceTimersByTimeAsync(45_001)
    expect(m.webContentsSend).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(120_001) // 弹窗无人响应
    expect(m.startInstance).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(10 * 60_000) // 下一轮被频控拦下
    expect(m.webContentsSend).toHaveBeenCalledTimes(1)
  })

  it('LLM 判定不需要分担 → 全链路止步于分析，不打扰用户', async () => {
    m.callSubAgent.mockResolvedValue(JSON.stringify({ shouldHelp: false }))
    const sut = await freshSut()
    await sut.setEnabled(true)
    await vi.advanceTimersByTimeAsync(45_001 + 10 * 60_000)
    expect(m.webContentsSend).not.toHaveBeenCalled()
    expect(m.startInstance).not.toHaveBeenCalled()
  })

  it('LLM 输出非 JSON / 无 API Key → 静默跳过本轮，不崩溃', async () => {
    m.callSubAgent.mockResolvedValue('我觉得用户挺好的不需要帮忙（不是 JSON）')
    const sut = await freshSut()
    await sut.setEnabled(true)
    await vi.advanceTimersByTimeAsync(45_001)
    expect(m.webContentsSend).not.toHaveBeenCalled()

    // 无 API Key：provider 无 key，分析直接跳过
    m.loadSettings.mockResolvedValue({ apiKey: '', baseUrl: 'https://x/v1', model: 'm', assistWatchEnabled: false })
    vi.resetModules()
    const sut2 = await freshSut()
    await sut2.setEnabled(true)
    await vi.advanceTimersByTimeAsync(45_001)
    expect(m.webContentsSend).not.toHaveBeenCalled()
  })

  it('开关关闭 → 定时器停止，任何时刻都不感知', async () => {
    const sut = await freshSut()
    await sut.setEnabled(true)
    await sut.setEnabled(false)
    await vi.advanceTimersByTimeAsync(45_001 + 10 * 60_000 + 120_001)
    expect(m.command).not.toHaveBeenCalled()
    expect(m.saveSettings).toHaveBeenLastCalledWith(expect.objectContaining({ assistWatchEnabled: false }))
  })

  it('感知失败（PiBridge 未就绪抛错）→ 本轮安全跳过，下轮重试', async () => {
    m.command.mockRejectedValue(new Error('helper not running'))
    const sut = await freshSut()
    await sut.setEnabled(true)
    await vi.advanceTimersByTimeAsync(45_001)
    expect(m.callSubAgent).not.toHaveBeenCalled()
    expect(m.webContentsSend).not.toHaveBeenCalled()

    m.command.mockResolvedValue({ roots: [{ title: '终端 — bash' }] })
    await vi.advanceTimersByTimeAsync(10 * 60_000)
    expect(m.callSubAgent).toHaveBeenCalledTimes(1)
  })
})
