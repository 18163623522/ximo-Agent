/**
 * 系统相关 IPC 处理器 — 注册入口，按原有顺序编排各子注册器
 * （窗口控制 → 操控电脑/终端 → 系统工具 → 隔离工作区 → Agent 任务）
 */

import { registerWindowHandlers } from './window-handlers'
import { registerComputerUseHandlers } from './computer-use-handlers'
import { registerSystemUtilityHandlers } from './system-utility-handlers'
import { registerWorkspaceHandlers } from './workspace-handlers'
import { registerAgentTaskHandlers } from './agent-task-handlers'

export function registerSystemHandlers(): void {
  // ---------- 窗口控制 ----------
  registerWindowHandlers()
  // ---------- 操控电脑（pi-computer-use）与终端命令执行 ----------
  registerComputerUseHandlers()
  // ---------- 系统字体 / Checkpoint / Tokenizer / 应用版本 ----------
  registerSystemUtilityHandlers()
  // ---------- Agent 隔离工作区（虚拟桌面 + WSL）----------
  registerWorkspaceHandlers()
  // ---------- Agent 定时任务 / Agent 系统 / 工作分摊 ----------
  registerAgentTaskHandlers()

  // 定时任务调度器 + Webhook 触发端点 + 工作分摊感知器 — 随 IPC 注册启动（应用运行期间生效）
  void import('@main/ScheduleStore').then(({ scheduleStore }) => scheduleStore.startScheduler())
  void import('@main/AgentSystemStore').then(({ agentSystemStore }) => agentSystemStore.startWebhookServer())
  void import('@main/AssistWatcher').then(({ assistWatcher }) => assistWatcher.init())
}
