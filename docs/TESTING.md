# TESTING.md — 测试体系与测试报告

> 运行全部测试：`npx vitest run`（当前 42 个文件 / 816 个用例，约 10-15s）
> 类型检查 + 构建冒烟：`npm run typecheck && npm run build`
> 行数规范检查：`AGENTS.md` 第 6 节（无自动化，PR 自查）

## 一、六类测试与目录映射

| 测试类型 | 目录 | 内容 |
|---|---|---|
| 功能测试 | `tests/functional/` `tests/main/` `tests/renderer/` `tests/shared/` | 权限引擎、安全守卫、上下文压缩、Agent 循环、桌面 ops、Provider、Store、转录适配等核心逻辑 |
| UI 测试 | `tests/ui/` | `ui-logic.test.ts`（UI 驱动纯逻辑）+ `components.test.tsx`（**jsdom 真渲染**：ConfirmDialog / AssistToggle / AssistProposalDialog / AgentSystemPanel 的渲染、状态切换、交互路径） |
| 模糊测试 | `tests/fuzz/` | 对 checkSsrf / checkSensitiveFile / checkWriteAccess / evaluate / normalize 系列投入随机与极端输入，断言不崩溃、返回值合法（URL 解析、路径穿越、regex 特殊字符、畸形 JSON/数字） |
| 回归测试 | `tests/regression/` + 各 functional 文件的历史 bug 用例 | 历史 bug 场景固定化（如 wsl UTF-16 解码、office type 透传、模型 ID 迁移）+ `permission-desktop-subjects.test.ts` 锁定 wsl_desktop 权限矩阵 |
| 集成测试 | `tests/integration/` | `integration.test.ts`（设置→权限→工具→缓存跨模块链）+ `ipc-contract.test.ts`（**main 注册 ↔ preload 引用双向对账**：invoke 通道全覆盖、事件推送通道有源、无重复注册） |
| 冒烟测试 | `tests/smoke/` | 核心模块可导入、类型/常量/注册表可用、构建链路健康 |

## 二、本轮新增（5 个文件 / 44 个用例）

1. `tests/functional/permission-desktop-subjects.test.ts` — wsl_desktop 权限决策矩阵（交互类 allow / exec·launch·set_resolution ask / 未枚举回退 / deny 优先级）
2. `tests/main/agent-workspace-ops.test.ts` — 桌面新动作命令构造：drag / key_down·key_up / 横向滚动 / clipboard_read / window_op（id·标题定位、geoArg）/ setResolution 边界 / exec 超时钳制与 stdin / launchApp 参数消毒与就绪探测 / manager 门闩
3. `tests/main/assist-watcher.test.ts` — 工作分摊全链路：接受流派发、拒绝流频控、fail-closed（无窗口）、120s 超时视为忽略、LLM 拒判/非 JSON/无 Key 安全跳过、开关关闭、感知失败下轮重试
4. `tests/integration/ipc-contract.test.ts` — IPC 通道契约：8 个子 handler 文件 + WebviewBridge 真实注册，preload 源码静态扫描对账（防拼写漂移断联）
5. `tests/ui/components.test.tsx` — 组件渲染与交互（详见上表 UI 行）

## 三、本轮测试发现并修复的缺陷

1. **SAFE_CONFIG 漏 `set_resolution` 审批**：coding/office 将"改分辨率重启桌面"归入 ask，safe 模式漏配 → 被静默放行。已补（`Permission.ts`），回归测试锁定。
2. **preload 死接口 `confirm.request`**：`invoke('confirm:request')` 在 main 侧从未注册 handler（调用必抛 No handler），渲染层也从未调用。已从 `shared/preload-api/shell.ts` 移除并留注释；契约测试防止复发。

## 四、已知边界与不稳定项

- `tests/main/tools/office-docs-e2e.test.ts` 依赖本机真实 Office/officecli，偶发环境抖动（出现过单次失败、复跑通过）。CI 中建议对该文件设置重试或隔离。
- `launchApp 3s 探测`用例依赖真实计时等待（约 3s），负载高时是全套件最慢用例之一。

## 五、自动化覆盖不了、需要人工的部分

| 场景 | 建议人工/半自动验证方式 |
|---|---|
| 真实 LLM 全链路（聊天/子 Agent/工作分摊分析质量） | 配好 API Key 后 `npm run dev`，三模式各跑一轮典型任务；观察权限弹窗与流式渲染 |
| WSL 隔离桌面真实 E2E | 桌面面板点启动 → 让 Agent 执行「打开终端 → 拖拽窗口 → 改分辨率 → 截图」脚本，人工核对画面流与 ffmpeg |
| Electron 窗口生命周期 | 最小化/最大化/关闭/重开、多显示器、窗口失焦通知 |
| 语音（whisper/edge-tts） | 真实麦克风输入与合成音试听 |
| 安装包 | `npm run build:win` 后实测安装/卸载/自更新 |
