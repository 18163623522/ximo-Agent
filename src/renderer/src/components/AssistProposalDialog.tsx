import { useEffect, useState } from 'react'
import { Bot, Eye } from 'lucide-react'

interface AssistProposal {
  id: string
  title: string
  observation: string
  proposedTask: string
}

/**
 * AssistProposalDialog — 工作分摊提议弹窗
 *
 * 主进程 AssistWatcher 感知到可分担的工作后推送 agent-assist:proposal，
 * 本弹窗展示观测依据与拟派发的任务，用户确认后才真正派发后台 Agent。
 * 点击遮罩 / 「不用了」= 拒绝；超时未响应主进程视为忽略。
 */
export function AssistProposalDialog(): React.ReactElement | null {
  const [proposal, setProposal] = useState<AssistProposal | null>(null)

  useEffect(() => {
    const off = window.api.assist.onProposal((p) => setProposal(p))
    return off
  }, [])

  if (!proposal) return null

  const respond = async (accepted: boolean): Promise<void> => {
    setProposal(null)
    try {
      await window.api.assist.respond(proposal.id, accepted)
    } catch { /* 响应失败主进程按超时忽略 */ }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-md animate-fade-in"
      onClick={() => respond(false)}
    >
      <div
        className="glass-panel mx-4 w-full max-w-lg p-6 animate-fade-scale"
        onClick={(e) => e.stopPropagation()}
      >
        {/* 头部 */}
        <div className="mb-4 flex items-start gap-3">
          <div className="accent-tile flex h-10 w-10 shrink-0 items-center justify-center rounded-panel shadow-lg shadow-accent/20">
            <Bot size={18} className="text-white" />
          </div>
          <div className="min-w-0 flex-1">
            <h3 className="text-sm font-semibold text-text-primary">Agent 想帮你分担一项工作</h3>
            <p className="mt-1 text-xs text-text-secondary">{proposal.title}</p>
          </div>
        </div>

        {/* 观测依据 */}
        {proposal.observation && (
          <div className="mb-3 rounded-card border border-border-subtle bg-bg-elevated/60 px-3 py-2.5">
            <div className="mb-1 flex items-center gap-1.5 text-caption font-medium text-text-muted">
              <Eye size={11} />
              我注意到
            </div>
            <p className="whitespace-pre-wrap text-xs leading-relaxed text-text-secondary">{proposal.observation}</p>
          </div>
        )}

        {/* 拟执行的任务 */}
        <div className="mb-5 rounded-card border border-border-subtle bg-bg-elevated/60 px-3 py-2.5">
          <div className="mb-1 flex items-center gap-1.5 text-caption font-medium text-text-muted">
            <Bot size={11} />
            打算交给后台 Agent 的任务
          </div>
          <p className="max-h-40 overflow-y-auto whitespace-pre-wrap text-xs leading-relaxed text-text-secondary">
            {proposal.proposedTask}
          </p>
        </div>

        <p className="mb-4 text-caption text-text-quaternary">
          任务会作为后台实例执行，过程与结果写入 Agent 系统面板；不影响你当前正在做的事。
        </p>

        <div className="flex justify-end gap-2">
          <button
            onClick={() => respond(false)}
            className="btn-ghost rounded-panel px-4 py-2 text-xs font-medium"
          >
            不用了
          </button>
          <button
            onClick={() => respond(true)}
            className="btn-liquid rounded-panel px-4 py-2 text-xs font-medium"
          >
            交给后台 Agent
          </button>
        </div>
      </div>
    </div>
  )
}
