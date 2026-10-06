/**
 * 视觉回路测试 — wsl_desktop(screenshot) 的留存路径闭环
 *
 * 视觉回路 = Agent 调 wsl_desktop 截图后，模型能"看见"画面。应用侧管道：
 * 截图 PNG 留存到 Windows 临时目录 → 工具结果携带路径 → Agent 用该路径调
 * vision_analyze(file_path=…) → 视觉模型返回画面描述文本。
 * 本测试锁定：截图结果必须给出可用的文件路径提示与 metadata.screenshotPath，
 * 否则 Agent 将回到"只有 base64 却无法分析"的断链状态（HANDOFF P1-2 的原始缺陷）。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

// Manager 单例打桩 — WSL 环境不可用于单测，只验证工具层对返回元的消费
vi.mock('../../../src/main/tools/AgentWorkspace/AgentWorkspaceManager', () => ({
  agentWorkspaceManager: {
    screenshotWithMeta: vi.fn(),
    ensureAlive: vi.fn(async () => true),
    getState: vi.fn(() => ({ running: true })),
  },
}))

import { agentWorkspaceManager } from '../../../src/main/tools/AgentWorkspace/AgentWorkspaceManager'
import { WslDesktopTool } from '../../../src/main/tools/AgentWorkspace/WslDesktopTool'
import type { ToolCall } from '../../../src/shared/types'

const mockedShot = vi.mocked(agentWorkspaceManager.screenshotWithMeta)

function makeToolCall(args: Record<string, unknown>): ToolCall {
  return { id: 'tc1', name: 'wsl_desktop', arguments: args }
}

const DATA_URL = 'data:image/png;base64,AAAA'

describe('视觉回路 — wsl_desktop screenshot 留存路径', () => {
  beforeEach(() => {
    mockedShot.mockReset()
  })

  it('screenshot 返回留存路径 — content 给出 vision_analyze(file_path) 指引，metadata 带路径', async () => {
    mockedShot.mockResolvedValue({ dataUrl: DATA_URL, savedPath: 'C:\\Users\\me\\AppData\\Local\\Temp\\ximo-agent-shots\\shot-1.png' })
    const res = await new WslDesktopTool().execute(makeToolCall({ action: 'screenshot' }))
    expect(res.success).toBe(true)
    expect(res.screenshot).toBe(DATA_URL)
    expect(res.metadata?.screenshotPath).toBe('C:\\Users\\me\\AppData\\Local\\Temp\\ximo-agent-shots\\shot-1.png')
    expect(res.content).toContain('vision_analyze')
    expect(res.content).toContain('shot-1.png')
  })

  it('留存不可用（无 /mnt 挂载）— 退回纯 base64 行为，无路径指引', async () => {
    mockedShot.mockResolvedValue({ dataUrl: DATA_URL })
    const res = await new WslDesktopTool().execute(makeToolCall({ action: 'screenshot' }))
    expect(res.success).toBe(true)
    expect(res.screenshot).toBe(DATA_URL)
    expect(res.metadata?.screenshotPath).toBeUndefined()
    expect(res.content).not.toContain('vision_analyze')
  })

  it('截图失败 — success=false 且无 screenshot', async () => {
    mockedShot.mockResolvedValue(null)
    const res = await new WslDesktopTool().execute(makeToolCall({ action: 'screenshot' }))
    expect(res.success).toBe(false)
    expect(res.screenshot).toBeUndefined()
  })

  it('操控类操作（click）的自动截图同样携带留存路径', async () => {
    mockedShot.mockResolvedValue({ dataUrl: DATA_URL, savedPath: 'C:\\tmp\\ximo-agent-shots\\shot-2.png' })
    const tool = new WslDesktopTool()
    // click 走 ensureAlive → click 实现；直接打桩 manager.click
    ;(agentWorkspaceManager as unknown as { click: ReturnType<typeof vi.fn> }).click = vi.fn(async () => true)
    const res = await tool.execute(makeToolCall({ action: 'click', x: 10, y: 20 }))
    expect(res.success).toBe(true)
    expect(res.metadata?.screenshotPath).toBe('C:\\tmp\\ximo-agent-shots\\shot-2.png')
  })
})
