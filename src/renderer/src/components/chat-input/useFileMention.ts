import { useState, useEffect, useMemo, useCallback } from 'react'
import type { FileTreeNode, Mode } from '@shared/types'

/** 扁平化文件树为路径列表 */
function flattenTree(nodes: FileTreeNode[], prefix = ''): string[] {
  const result: string[] = []
  for (const node of nodes) {
    const fullPath = prefix ? `${prefix}/${node.name}` : node.name
    if (node.type === 'file') result.push(fullPath)
    if (node.children && node.children.length > 0) result.push(...flattenTree(node.children, fullPath))
  }
  return result
}

/** 特殊提及：Agent 系统桌面 — 消息发送后由 buildUserMessage 路由给桌面 Agent */
export const DESKTOP_MENTION = '@Agent系统桌面'

/** @file 引用 hook — 检测 @ 触发候选列表（项目文件 + Agent 系统桌面），键盘导航 */
export function useFileMention(
  textareaRef: React.RefObject<HTMLTextAreaElement>,
  text: string,
  setText: (t: string) => void,
  currentMode: Mode,
  projectPath: string,
): {
  showFileMention: boolean
  matchedFiles: string[]
  desktopMentionAvailable: boolean
  selectedMentionIndex: number
  setSelectedMentionIndex: React.Dispatch<React.SetStateAction<number>>
  insertFileMention: (filePath: string) => void
  insertDesktopMention: () => void
  handleMentionKeyDown: (e: React.KeyboardEvent<HTMLTextAreaElement>) => boolean
} {
  const [showFileMention, setShowFileMention] = useState(false)
  const [mentionQuery, setMentionQuery] = useState('')
  const [projectFiles, setProjectFiles] = useState<string[]>([])
  const [selectedMentionIndex, setSelectedMentionIndex] = useState(0)

  useEffect(() => {
    if (currentMode !== 'coding' || !projectPath) { setProjectFiles([]); return }
    let cancelled = false
    const loadFiles = async (): Promise<void> => {
      try {
        const tree = await window.api.fs.listDir(projectPath)
        if (!cancelled && tree) setProjectFiles(flattenTree(tree))
      } catch { /* 静默处理 */ }
    }
    void loadFiles()
    return () => { cancelled = true }
  }, [projectPath, currentMode])

  useEffect(() => {
    const ta = textareaRef.current
    if (!ta) return
    const cursorPos = ta.selectionStart
    const beforeCursor = text.slice(0, cursorPos)
    const atMatch = beforeCursor.match(/@([^\s@]*)$/)
    if (atMatch) {
      setMentionQuery(atMatch[1])
      setShowFileMention(true)
      setSelectedMentionIndex(0)
    } else {
      setShowFileMention(false)
    }
  }, [text, textareaRef])

  const matchedFiles = useMemo(() => {
    if (currentMode !== 'coding' || !projectPath) return []
    if (!mentionQuery) return projectFiles.slice(0, 10)
    const lower = mentionQuery.toLowerCase()
    return projectFiles.filter((f) => f.toLowerCase().includes(lower)).slice(0, 10)
  }, [mentionQuery, projectFiles, currentMode, projectPath])

  /** 桌面提及是否可候选 — 空 query 直接候选；否则按前缀模糊匹配 */
  const desktopMentionAvailable = useMemo(() => {
    if (!mentionQuery) return true
    return 'agent系统桌面'.includes(mentionQuery.toLowerCase())
  }, [mentionQuery])

  /** 用选中的候选替换光标前的 @query */
  const replaceMention = useCallback((token: string): void => {
    const ta = textareaRef.current
    if (!ta) return
    const cursorPos = ta.selectionStart
    const beforeCursor = text.slice(0, cursorPos)
    const afterCursor = text.slice(cursorPos)
    const nextBefore = beforeCursor.replace(/@([^\s@]*)$/, `${token} `)
    setText(nextBefore + afterCursor)
    setShowFileMention(false)
    requestAnimationFrame(() => {
      ta.focus()
      ta.setSelectionRange(nextBefore.length, nextBefore.length)
    })
  }, [text, textareaRef, setText])

  const insertFileMention = useCallback((filePath: string): void => {
    replaceMention(`@${filePath}`)
  }, [replaceMention])

  const insertDesktopMention = useCallback((): void => {
    replaceMention(DESKTOP_MENTION)
  }, [replaceMention])

  const handleMentionKeyDown = useCallback((e: React.KeyboardEvent<HTMLTextAreaElement>): boolean => {
    const total = (desktopMentionAvailable ? 1 : 0) + matchedFiles.length
    if (showFileMention && total > 0) {
      if (e.key === 'ArrowDown') { e.preventDefault(); setSelectedMentionIndex((prev) => (prev + 1) % total); return true }
      if (e.key === 'ArrowUp') { e.preventDefault(); setSelectedMentionIndex((prev) => (prev - 1 + total) % total); return true }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault()
        if (desktopMentionAvailable && selectedMentionIndex === 0) {
          insertDesktopMention()
        } else {
          const fileIndex = selectedMentionIndex - (desktopMentionAvailable ? 1 : 0)
          insertFileMention(matchedFiles[fileIndex])
        }
        return true
      }
      if (e.key === 'Escape') { e.preventDefault(); setShowFileMention(false); return true }
    }
    return false
  }, [showFileMention, desktopMentionAvailable, matchedFiles, selectedMentionIndex, insertDesktopMention, insertFileMention])

  return {
    showFileMention, matchedFiles, desktopMentionAvailable,
    selectedMentionIndex, setSelectedMentionIndex,
    insertFileMention, insertDesktopMention, handleMentionKeyDown,
  }
}
