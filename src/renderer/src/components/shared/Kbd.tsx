// ── Kbd — 键盘按键徽标 ────────────────────────────────────────────────
// Quiet Precision 风格签名件：keyboard 感 = 效率工具的专业味。
// 发丝线 + 底部 1.5px 加厚（模拟键帽侧壁），等宽字。
// onFill 用于主题色填充底上的反白变体（如"新建任务"主按钮内）。

export function Kbd({ children, onFill = false }: { children: React.ReactNode; onFill?: boolean }): React.ReactElement {
  return (
    <kbd
      style={{
        fontFamily: 'var(--font-mono)',
        fontSize: 12,
        lineHeight: 1,
        color: onFill ? 'rgba(255, 255, 255, 0.75)' : 'var(--text-tertiary)',
        background: onFill ? 'rgba(255, 255, 255, 0.12)' : 'var(--bg-surface)',
        border: '0.5px solid',
        borderColor: onFill ? 'rgba(255, 255, 255, 0.25)' : 'var(--border-DEFAULT)',
        borderBottomWidth: '1.5px',
        borderRadius: 4,
        padding: '2px 5px',
        display: 'inline-flex',
        alignItems: 'center',
      }}
    >
      {children}
    </kbd>
  )
}
