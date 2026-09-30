// @vitest-environment jsdom
/**
 * UI 测试 — 组件真实渲染与交互（jsdom + @testing-library/react）
 *
 * 此前 tests/ui/ui-logic.test.ts 只能覆盖纯逻辑（项目未配 jsdom）；
 * 本文件补上组件层：ConfirmDialog / AssistToggle / AssistProposalDialog /
 * AgentSystemPanel 的渲染、状态切换与用户交互路径。
 * window.api（preload 注入）以 mock 对象注入。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react'
import { ConfirmDialog } from '../../src/renderer/src/components/ConfirmDialog'
import { AssistToggle } from '../../src/renderer/src/components/panels/AgentSystemPanel/AssistToggle'
import { AssistProposalDialog } from '../../src/renderer/src/components/AssistProposalDialog'
import { AgentSystemPanel } from '../../src/renderer/src/components/panels/AgentSystemPanel'

const storeState = vi.hoisted(() => ({
  showAgentSystemPanel: true,
  setShowAgentSystemPanel: vi.fn(),
  selectConversation: vi.fn(),
}))

vi.mock('@renderer/store/useStore', () => ({
  useStore: (sel: (s: typeof storeState) => unknown) => sel(storeState),
}))

function makeApi() {
  return {
    assist: {
      get: vi.fn(async () => ({ enabled: false, lastCheckAt: 0 })),
      set: vi.fn(async (on: boolean) => ({ enabled: on })),
      respond: vi.fn(async () => ({ success: true })),
      onProposal: vi.fn(() => () => {}),
    },
    agentSystem: {
      listInstances: vi.fn(async () => ({ success: true, instances: [] })),
      listDefinitions: vi.fn(async () => ({ success: true, definitions: [] })),
      onInstancesUpdated: vi.fn(() => () => {}),
      onInstanceActivity: vi.fn(() => () => {}),
      onConversationUpdated: vi.fn(() => () => {}),
    },
    schedule: {
      list: vi.fn(async () => ({ success: true, schedules: [] })),
      getPaused: vi.fn(async () => ({ paused: false })),
    },
  }
}

type Api = ReturnType<typeof makeApi>
let api: Api

beforeEach(() => {
  api = makeApi()
  ;(window as unknown as { api: Api }).api = api
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('ConfirmDialog — 敏感操作确认弹窗', () => {
  it('关闭态渲染 null；打开态展示标题与正文', () => {
    const { container: closed } = render(<ConfirmDialog open={false} title="t" message="m" onConfirm={() => {}} onCancel={() => {}} />)
    expect(closed.innerHTML).toBe('')

    render(<ConfirmDialog open title="确认执行操作" message="将执行 terminal 命令" onConfirm={() => {}} onCancel={() => {}} />)
    expect(screen.getByText('确认执行操作')).toBeTruthy()
    expect(screen.getByText('将执行 terminal 命令')).toBeTruthy()
  })

  it('取消 / 确认按钮分别触发 onCancel / onConfirm', () => {
    const onConfirm = vi.fn()
    const onCancel = vi.fn()
    render(<ConfirmDialog open title="t" message="m" onConfirm={onConfirm} onCancel={onCancel} />)
    fireEvent.click(screen.getByText('取消'))
    expect(onCancel).toHaveBeenCalledTimes(1)
    expect(onConfirm).not.toHaveBeenCalled()
    fireEvent.click(screen.getByText('确认执行'))
    expect(onConfirm).toHaveBeenCalledTimes(1)
  })

  it('勾选「不再提示」后确认 → 额外触发 onRemember（自动化等级切换路径）', () => {
    const onConfirm = vi.fn()
    const onRemember = vi.fn()
    const { container } = render(<ConfirmDialog open title="t" message="m" onConfirm={onConfirm} onCancel={() => {}} onRemember={onRemember} />)
    const checkbox = container.querySelector('input[type="checkbox"]') as HTMLInputElement
    fireEvent.click(checkbox)
    fireEvent.click(screen.getByText('确认执行'))
    expect(onConfirm).toHaveBeenCalledTimes(1)
    expect(onRemember).toHaveBeenCalledTimes(1)
  })
})

describe('AssistToggle — 工作分摊开关', () => {
  it('挂载时读取开关状态；未开启时展示征求同意说明', async () => {
    render(<AssistToggle />)
    expect(api.assist.get).toHaveBeenCalledTimes(1)
    expect(await screen.findByText('工作分摊')).toBeTruthy()
    expect(screen.getByText(/开启后定期感知我的电脑/)).toBeTruthy()
  })

  it('点击开关 → 调 assist.set(true)，描述文案切换为已开启态', async () => {
    render(<AssistToggle />)
    fireEvent.click(await screen.findByText('工作分摊'))
    expect(api.assist.set).toHaveBeenCalledWith(true)
    expect(await screen.findByText(/每 10 分钟感知一次我的电脑/)).toBeTruthy()
  })
})

describe('AssistProposalDialog — 工作分摊提议弹窗', () => {
  it('无提议时渲染 null；收到推送后展示观测依据与拟派任务', async () => {
    let push: ((p: { id: string; title: string; observation: string; proposedTask: string }) => void) | undefined
    api.assist.onProposal.mockImplementation((cb: typeof push) => { push = cb; return () => {} })

    render(<AssistProposalDialog />)
    expect(screen.queryByText('Agent 想帮你分担一项工作')).toBeNull()

    act(() => {
      push?.({ id: 'p1', title: '整理季度报告', observation: 'Excel 正在编辑', proposedTask: '整理数据并汇总' })
    })
    expect(screen.getByText('Agent 想帮你分担一项工作')).toBeTruthy()
    expect(screen.getByText('整理季度报告')).toBeTruthy()
    expect(screen.getByText('Excel 正在编辑')).toBeTruthy()
    expect(screen.getByText('整理数据并汇总')).toBeTruthy()
  })

  it('「交给后台 Agent」→ respond(id, true)；点遮罩 / 「不用了」→ respond(id, false)', async () => {
    let push: ((p: { id: string; title: string; observation: string; proposedTask: string }) => void) | undefined
    api.assist.onProposal.mockImplementation((cb: typeof push) => { push = cb; return () => {} })

    render(<AssistProposalDialog />)
    act(() => {
      push?.({ id: 'p1', title: 'T', observation: '', proposedTask: 'P' })
    })

    fireEvent.click(screen.getByText('不用了'))
    expect(api.assist.respond).toHaveBeenCalledWith('p1', false)
    expect(screen.queryByText('Agent 想帮你分担一项工作')).toBeNull()

    act(() => {
      push?.({ id: 'p2', title: 'T2', observation: '', proposedTask: 'P2' })
    })
    fireEvent.click(screen.getByText('交给后台 Agent'))
    expect(api.assist.respond).toHaveBeenCalledWith('p2', true)
  })
})

describe('AgentSystemPanel — Agent 系统面板骨架', () => {
  it('渲染标题、工作分摊开关与三个 Tab；Tab 可切换不崩溃', async () => {
    render(<AgentSystemPanel />)
    expect(await screen.findByText('Agent 系统')).toBeTruthy()
    expect(screen.getByText('工作分摊')).toBeTruthy()
    expect(screen.getByText('实例')).toBeTruthy()
    expect(screen.getByText('定时任务')).toBeTruthy()
    expect(screen.getByText('Agent 定义')).toBeTruthy()

    fireEvent.click(screen.getByText('定时任务'))
    fireEvent.click(screen.getByText('Agent 定义'))
    fireEvent.click(screen.getByText('实例'))
    // 空数据下面板保持挂载（无崩溃即通过）
    expect(screen.getByText('Agent 系统')).toBeTruthy()
  })
})
