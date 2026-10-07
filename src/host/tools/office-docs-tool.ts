/**
 * office 工具 — 主机侧 Agent 的 OOXML 文档读写（阶段 2）
 *
 * 为何自建而非复用主应用 OfficeDocsTool：后者依赖 officecli.exe（Windows PE
 * 二进制，Linux 主机跑不了）。而 OOXML（.docx/.xlsx/.pptx）本质是 zip + XML，
 * Python 标准库即可解析——宿主实测无 pip / 无 LibreOffice / 无 pandoc，
 * 零依赖是唯一可行路径（helper 脚本：os/scripts/ooxml-helper.py）。
 *
 * 能力边界（如实声明）：读全文/结构摘要/工作表/文本替换。复杂排版生成请在
 * GUI 应用里做（desktop 工具 + app.launch）。
 * 权限：读与替换均 allow（与 file_edit 同级，工作区写白名单仍生效）。
 */
import { execFile } from 'child_process'
import { promisify } from 'util'
import { existsSync } from 'fs'
import { dirname, basename, join } from 'path'
import type { Tool } from '../../main/tools/Tool'
import type { ToolDefinition, ToolCall, ToolResult, StreamChunk } from '../../shared/types'

const execFileAsync = promisify(execFile)

type Action = 'read' | 'info' | 'sheets' | 'replace' | 'convert'
const ACTIONS: Action[] = ['read', 'info', 'sheets', 'replace', 'convert']

/**
 * helper 脚本路径 — 按候选顺序探测。
 * 注意：**不能**用 import.meta.url —— host 产物是 esbuild 的 CJS 单文件，
 * import.meta 为 undefined（此前由此导致 fileURLToPath 抛错）。
 * 改用 __dirname（CJS 下可用）与环境变量。
 */
function helperPath(): string {
  if (process.env.XIMO_OOXML_HELPER) return process.env.XIMO_OOXML_HELPER
  const candidates = [
    // 镜像布局：与 agent-hostd 同目录
    join(process.env.XIMO_HOST_HOME || '/opt/ximo-host', 'ooxml-helper.py'),
    // 开发/WSL1 部署：/root/ximo-host/ooxml-helper.py
    join(process.env.HOME || '/root', 'ximo-host', 'ooxml-helper.py'),
    // 仓库布局：dist-host/ 的上一级 os/scripts/
    join(typeof __dirname === 'string' ? __dirname : '.', '..', '..', 'os', 'scripts', 'ooxml-helper.py'),
  ]
  return candidates.find((p) => existsSync(p)) ?? candidates[0]
}

interface HelperResult { ok: boolean; error?: string; [k: string]: unknown }

export class OfficeDocsTool implements Tool {
  readonly definition: ToolDefinition = {
    name: 'office_docs',
    description:
      '读写 Office 文档（.docx/.xlsx/.pptx，OOXML 格式，零依赖解析）。\n' +
      '动作: read 读全文（段落+表格 / 工作表单元格 / 幻灯片文本）| info 结构摘要（类型/字数/段落数/表格数/行数）| sheets 列出工作表与范围（仅 xlsx）| replace 文本替换（filePath + old + new，原地改写）| convert 旧格式转 OOXML（.doc/.xls/.ppt → 同名 .docx/.xlsx/.pptx，依赖 LibreOffice，仅镜像环境）。\n' +
      '典型：先 info 了解结构 → read 取内容 → 需要改动用 replace。旧格式先 convert 再 read。\n' +
      '限制：仅 OOXML（.doc 等旧二进制格式用 convert 转换后再读）；复杂排版请在 GUI 应用里做（desktop 工具）。',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', description: '操作类型', enum: ACTIONS },
        filePath: { type: 'string', description: '文档路径（.docx/.xlsx/.pptx）' },
        old: { type: 'string', description: '替换：被替换文本（replace）' },
        new: { type: 'string', description: '替换：新文本（replace）' },
      },
      required: ['action', 'filePath'],
    },
  }

  async execute(toolCall: ToolCall, onChunk?: (c: StreamChunk) => void): Promise<ToolResult> {
    const action = (toolCall.arguments.action as Action) || ''
    const filePath = (toolCall.arguments.filePath as string) || ''
    onChunk?.({ toolStatus: 'calling', toolName: 'office_docs' })

    if (!ACTIONS.includes(action)) {
      return this.error(toolCall.id, `未知操作: ${String(action)}（可选: ${ACTIONS.join('/')}）`)
    }
    if (!filePath) return this.error(toolCall.id, 'filePath 参数必填')

    if (action === 'convert') return this.convert(toolCall, filePath, onChunk)

    const argv = [helperPath(), action, filePath]
    if (action === 'replace') {
      const oldText = toolCall.arguments.old
      const newText = toolCall.arguments.new
      if (typeof oldText !== 'string' || typeof newText !== 'string') {
        return this.error(toolCall.id, 'replace 需要 old 与 new 参数（均为字符串）')
      }
      argv.push(oldText, newText)
    }

    try {
      const { stdout } = await execFileAsync('python3', argv, { timeout: 30_000, maxBuffer: 8 << 20 })
      const parsed = JSON.parse(stdout) as HelperResult
      onChunk?.({ toolStatus: 'done', toolName: 'office_docs' })
      if (!parsed.ok) return this.error(toolCall.id, String(parsed.error ?? '文档处理失败'))
      // 文本类结果直接给模型（可读性优于 JSON）
      const content = typeof parsed.text === 'string' ? parsed.text
        : parsed.sheets ? `工作表：${(parsed.sheets as { name: string; rows: number; range: string }[]).map(s => `${s.name}(${s.rows}行,${s.range || '-'})`).join('、')}`
        : parsed.replacements !== undefined ? `已替换 ${parsed.replacements} 处`
        : JSON.stringify(parsed)
      return {
        toolCallId: toolCall.id,
        toolName: 'office_docs',
        content,
        success: true,
        metadata: { action, ...(parsed.type ? { docType: parsed.type } : {}) },
      }
    } catch (e) {
      onChunk?.({ toolStatus: 'done', toolName: 'office_docs' })
      const msg = (e as Error).message ?? String(e)
      if (msg.includes('ENOENT')) {
        return this.error(toolCall.id, '主机缺少 python3 或 ooxml-helper.py（检查 /opt/ximo-host/ooxml-helper.py）')
      }
      return this.error(toolCall.id, `文档处理失败：${msg.slice(0, 200)}`)
    }
  }

  /** convert — 旧二进制格式 → OOXML（LibreOffice headless；仅镜像环境安装） */
  private async convert(toolCall: ToolCall, filePath: string, onChunk?: (c: StreamChunk) => void): Promise<ToolResult> {
    const ext = filePath.toLowerCase().split('.').pop() ?? ''
    const target = ({ doc: 'docx', xls: 'xlsx', ppt: 'pptx' } as Record<string, string>)[ext]
    if (!target) return this.error(toolCall.id, `convert 需要 .doc/.xls/.ppt 源文件（收到 .${ext}；OOXML 可直接 read）`)
    const outdir = dirname(filePath)
    try {
      const { stdout } = await execFileAsync('soffice',
        ['--headless', '--convert-to', target, '--outdir', outdir, filePath],
        { timeout: 180_000, maxBuffer: 4 << 20 })
      const outFile = join(outdir, `${basename(filePath, '.' + ext)}.${target}`)
      if (!existsSync(outFile)) {
        return this.error(toolCall.id, `转换未产出文件。soffice 输出: ${stdout.slice(0, 200)}`)
      }
      onChunk?.({ toolStatus: 'done', toolName: 'office_docs' })
      return {
        toolCallId: toolCall.id,
        toolName: 'office_docs',
        content: `已转换为: ${outFile}（随后可用 office_docs action=read 读取）`,
        success: true,
      }
    } catch (e) {
      return this.error(toolCall.id, `convert 失败: ${(e as Error).message.slice(0, 200)}（convert 依赖 LibreOffice——仅 ximo-OS 镜像环境提供）`)
    }
  }

  private error(id: string, msg: string): ToolResult {
    return { toolCallId: id, toolName: 'office_docs', content: '', success: false, error: msg }
  }
}
