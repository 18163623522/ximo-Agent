/**
 * Ximo Icons · 精工线性 v1 — 统一出口
 *
 * 70 个高频字形自绘，键名与 lucide-react 组件名一一对应，
 * 由 lib/lucide-bridge 以显式导出覆盖同名 lucide 图标。
 */
import { createXimoIcon } from './create-ximo-icon'
import { XIMO_CORE } from './spec-core'
import { XIMO_OBJECTS } from './spec-objects'
import { XIMO_EXTRAS } from './spec-extras'

const DEFS = { ...XIMO_CORE, ...XIMO_OBJECTS, ...XIMO_EXTRAS }

function build(name: string) {
  const parts = DEFS[name]
  if (!parts) throw new Error(`[ximo-icons] missing glyph spec: ${name}`)
  return createXimoIcon(name, parts)
}

export const ChevronDown = build('ChevronDown')
export const ChevronUp = build('ChevronUp')
export const ChevronLeft = build('ChevronLeft')
export const ChevronRight = build('ChevronRight')
export const X = build('X')
export const Check = build('Check')
export const Plus = build('Plus')
export const Minus = build('Minus')
export const ArrowUp = build('ArrowUp')
export const ArrowDown = build('ArrowDown')
export const ArrowLeft = build('ArrowLeft')
export const ArrowRight = build('ArrowRight')
export const CheckCircle2 = build('CheckCircle2')
export const XCircle = build('XCircle')
export const AlertTriangle = build('AlertTriangle')
export const AlertCircle = build('AlertCircle')
export const Info = build('Info')
export const HelpCircle = build('HelpCircle')
export const Ban = build('Ban')
export const Clock = build('Clock')
export const Loader2 = build('Loader2')
export const Search = build('Search')
export const Square = build('Square')
export const CircleDot = build('CircleDot')
export const MoreHorizontal = build('MoreHorizontal')
export const MoreVertical = build('MoreVertical')
export const FileText = build('FileText')
export const FolderOpen = build('FolderOpen')
export const Terminal = build('Terminal')
export const Globe = build('Globe')
export const Cpu = build('Cpu')
export const Box = build('Box')
export const Layers = build('Layers')
export const Server = build('Server')
export const Monitor = build('Monitor')
export const Copy = build('Copy')
export const Trash2 = build('Trash2')
export const Pencil = build('Pencil')
export const Edit3 = build('Edit3')
export const Send = build('Send')
export const Paperclip = build('Paperclip')
export const AtSign = build('AtSign')
export const Settings = build('Settings')
export const Palette = build('Palette')
export const Brain = build('Brain')
export const Bot = build('Bot')
export const Code2 = build('Code2')
export const Key = build('Key')
export const Wrench = build('Wrench')
export const Users = build('Users')
export const Type = build('Type')
export const MessageSquare = build('MessageSquare')
export const Sparkles = build('Sparkles')
export const Zap = build('Zap')
export const Eye = build('Eye')
export const Play = build('Play')
export const Upload = build('Upload')
export const Download = build('Download')
export const RotateCcw = build('RotateCcw')
export const RefreshCw = build('RefreshCw')
export const Undo2 = build('Undo2')
export const Reply = build('Reply')
export const ExternalLink = build('ExternalLink')
export const History = build('History')
export const Bell = build('Bell')
export const Star = build('Star')
export const Sun = build('Sun')
export const Moon = build('Moon')
export const GitBranch = build('GitBranch')
