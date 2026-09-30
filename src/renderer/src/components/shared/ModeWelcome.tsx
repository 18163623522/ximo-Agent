import { Icon } from '@renderer/components/Icon'

interface ModeWelcomeProps {
  /** 模式图标名（ICON_MAP 里的键） */
  icon: string
  /** 模式名称 */
  title: string
  /** 一句话描述 */
  description: string
  /** 已绑定的项目路径 — 有则显示一行只读提示 */
  projectPath?: string
}

/**
 * ModeWelcome — 三个模式统一的空态欢迎
 *
 * 只保留「图标 + 模式名 + 一句话描述（+ 当前项目）」，不放任何快捷指令卡片：
 * 快捷指令改由输入框的斜杠命令承担，空态保持极简，也让输入框的垂直居中真正成立。
 */
export function ModeWelcome({ icon, title, description, projectPath }: ModeWelcomeProps): React.ReactElement {
  return (
    <div className="flex w-full flex-col items-center px-6 text-center animate-fade-in">
      <div className="accent-tile mb-5 flex h-16 w-16 items-center justify-center rounded-panel shadow-xl shadow-accent/20 animate-float">
        <Icon name={icon} size={32} className="text-white" />
      </div>
      <h1 className="text-4xl font-semibold tracking-tight text-text-primary">{title}</h1>
      {/* 刊头线 — 两侧淡出的细分隔，标题与描述之间的仪式感 */}
      <div aria-hidden className="mt-4 h-px w-10 bg-gradient-to-r from-transparent via-border-DEFAULT to-transparent" />
      <p className="mt-4 max-w-md text-sm leading-relaxed text-text-secondary">{description}</p>
      {projectPath && (
        <p className="mt-3 text-caption text-text-muted">
          当前项目：<span className="text-text-secondary">{projectPath.split(/[/\\]/).pop()}</span>
        </p>
      )}
    </div>
  )
}
