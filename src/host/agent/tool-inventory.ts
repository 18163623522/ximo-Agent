/**
 * 主机工具清单 — 纯数据模块（零 import，供对账测试直接消费）
 *
 * 从 task-runner 抽出的原因：task-runner 顶层有 electron-shim 副作用 import，
 * 契约测试（tests/functional/permission-tool-reconciliation.test.ts）需要在不
 * 触发任何运行时副作用的情况下读取这份清单。
 */

/** 主机可移植工具域 — 与 lazy-registry 的模块组一一对应 */
export const HOST_TOOL_GROUPS = [
  'file_system', 'terminal', 'git', 'web_intelligence', 'memory', 'skill', 'vision',
  // 代码质量 — 主机默认 coding 模式，无此组则无法 lint/格式化/依赖检查/项目索引
  // （全组零 electron import，纯 Node 可移植）
  'code_quality', 'code_review',
]

export const HOST_TOOL_NAMES = [
  // file_system
  'file_read', 'file_write', 'file_list', 'file_search', 'file_edit', 'file_delete',
  'multi_edit', 'move_file', 'todo_write',
  // terminal / git
  'terminal_exec', 'git_operations',
  // web_intelligence
  'web_search', 'web_fetch', 'web_cache', 'web_research',
  // memory
  'memory_update', 'knowledge',
  // skill
  'skill_record', 'skill_invoke', 'agent_expert', 'create_tool',
  // vision — 配套 desktop 截图：Agent 截屏后据此理解画面内容
  'vision_analyze',
  // code_quality — 代码执行/检查/格式化/依赖/项目上下文与索引
  'code_execute', 'code_lint', 'code_format', 'dependency_check',
  'project_context', 'project_index',
  // code_review — 代码审查
  'code_review',
]
