// ── 工具元数据与摘要 ────────────────────────────────────────────────────
// 工具名标签映射、只读/Shell 工具判断、工具结果摘要提取。
// 从 transcriptAdapter 拆出：纯常量映射 + 无状态函数。

// 工具名 → 中文标签
const TOOL_LABELS: Record<string, string> = {
  web_search: '联网搜索', web_fetch: '网页抓取', web_research: '深度研究',
  file_read: '读取文件', file_write: '写入文件', file_list: '列出文件',
  file_search: '搜索文件', file_edit: '编辑文件', file_delete: '删除文件',
  multi_edit: '批量编辑', move_file: '移动文件', terminal_exec: '执行命令',
  git_operations: 'Git 操作', code_execute: '运行代码', code_lint: '代码检查',
  code_format: '代码格式化', dependency_check: '依赖检查',
  project_context: '项目扫描', ui_generate: 'UI 生成',
  browser_navigate: '浏览器导航', browser_screenshot: '浏览器截图',
  browser_click: '点击', browser_type: '输入', browser_get_content: '提取内容',
  browser_execute_js: '执行JS', browser_network_monitor: '网络监控',
  screen_capture: '截屏', find_roots: '查找窗口', observe_ui: '观察UI',
  search_ui: '搜索UI', act_ui: '操作UI', read_text: '读取文本',
  wait_for: '等待', network_capture: '抓包', network_replay: '重放',
  storage_inspect: '存储检查', js_hook: 'Hook', api_extract: 'API提取',
  skill_record: '录制技能', skill_invoke: '调用技能',
  design_preview: '设计预览', design_critique: '设计审查',
  design_audit: '质量审计', design_a11y: '无障碍检查', design_color: '颜色分析',
}

export function toolLabel(name: string): string {
  return TOOL_LABELS[name] || name
}

// 只读工具判断
const READ_ONLY_TOOLS = new Set([
  'file_read', 'file_list', 'file_search', 'web_fetch', 'web_search',
  'web_research', 'project_context', 'code_index', 'screen_capture',
  'browser_screenshot', 'browser_get_content', 'observe_ui', 'search_ui',
  'read_text', 'code_lint', 'dependency_check', 'design_preview',
  'design_critique', 'design_audit', 'design_a11y', 'design_color',
])

export function isReadOnlyTool(name: string): boolean {
  return READ_ONLY_TOOLS.has(name)
}

export function isShellTool(name: string): boolean {
  return name === 'terminal_exec' || name === 'bash' || name === 'bash_output'
}

/** 从 ToolResult 提取摘要 */
/**
 * 无参数可提取的工具 → 用固定标签。
 * 这些工具（项目扫描类）的入参里没有 path/query/command，
 * 之前会回退到"拿输出的首行当标题"，于是 markdown 标题原样漏进了行内摘要，
 * 例如 `## 📁 项目上下文：\`D:\...\`` —— 又长又脏，还把真正的信息淹掉了。
 */
const STATIC_TOOL_LABELS: Record<string, string> = {
  project_context: '项目上下文',
  project_index: '项目语义索引',
  file_list: '目录列表'
}

/** 输出的首行是否"像一个标签" —— 拒绝 markdown 结构行与「标题：长内容」这类句子 */
function isLabelLike(line: string): boolean {
  const t = line.trim()
  if (!t || t.length > 40) return false
  if (/^[#>*\-+`|\d]/.test(t)) return false // markdown 结构行 / 有序列表
  if (/[：:]\s*\S{10,}/.test(t)) return false // 「标题：一长串内容」
  return true
}

export function summarizeToolResult(name: string, args: string, output?: string): string {
  try {
    const parsed = JSON.parse(args)
    if (parsed.query || parsed.question) return `"${parsed.query || parsed.question}"`
    if (parsed.path || parsed.filePath) {
      const p = parsed.path || parsed.filePath
      return p.split(/[/\\]/).pop() || p
    }
    if (parsed.command) return `$ ${parsed.command}`
    if (parsed.url) return parsed.url
  } catch { /* ignore */ }
  const fixed = STATIC_TOOL_LABELS[name]
  if (fixed) return fixed
  if (output) {
    const firstLine = output.split('\n')[0]?.slice(0, 80) ?? ''
    if (isLabelLike(firstLine)) return firstLine
  }
  return ''
}
