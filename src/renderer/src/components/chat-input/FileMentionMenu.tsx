import { FileText, Monitor } from 'lucide-react'

interface FileMentionMenuProps {
  files: string[]
  selectedIndex: number
  /** 桌面提及候选是否置顶显示（@Agent系统桌面） */
  desktopMention?: boolean
  onSelect: (file: string) => void
  onSelectDesktop?: () => void
  onHover: (index: number) => void
}

/** @ 提及弹出菜单 — 项目文件引用 + Agent 系统桌面 */
export function FileMentionMenu({
  files, selectedIndex, desktopMention = false, onSelect, onSelectDesktop, onHover,
}: FileMentionMenuProps): React.ReactElement | null {
  if (files.length === 0 && !desktopMention) return null

  // 桌面提及置顶时，文件候选的索引整体 +1
  const fileIndexOffset = desktopMention ? 1 : 0

  return (
    <div className="mx-4 mb-1 max-h-48 overflow-y-auto rounded-panel border border-border-subtle bg-bg-elevated-soft backdrop-blur-xl shadow-glass animate-scale-in">
      <div className="px-3 py-1.5 text-caption text-text-muted border-b border-border-subtle">
        提及 — ↑↓ 导航，Enter/Tab 确认，Esc 取消
      </div>
      {desktopMention && (
        <button
          onMouseDown={(e) => {
            e.preventDefault()
            onSelectDesktop?.()
          }}
          onMouseEnter={() => onHover(0)}
          className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs transition-colors ${
            selectedIndex === 0 ? 'bg-accent/10 text-accent' : 'text-text-secondary hover:bg-bg-hover'
          }`}
        >
          <Monitor size={13} className="shrink-0 text-accent" />
          <span className="font-medium">Agent系统桌面</span>
          <span className="text-text-tertiary text-caption truncate">让 Agent 在隔离图形桌面中替你操作</span>
        </button>
      )}
      {files.map((file, i) => {
        const fileName = file.split('/').pop() || file
        const dir = file.includes('/') ? file.slice(0, file.lastIndexOf('/')) : ''
        const idx = i + fileIndexOffset
        return (
          <button
            key={file}
            onMouseDown={(e) => {
              e.preventDefault()
              onSelect(file)
            }}
            onMouseEnter={() => onHover(idx)}
            className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs transition-colors ${
              idx === selectedIndex ? 'bg-accent/10 text-accent' : 'text-text-secondary hover:bg-bg-hover'
            }`}
          >
            <FileText size={13} className="shrink-0 opacity-60" />
            <span className="font-mono truncate">{fileName}</span>
            {dir && <span className="text-text-tertiary text-caption truncate">{dir}</span>}
          </button>
        )
      })}
    </div>
  )
}
