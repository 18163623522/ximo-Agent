import { useState } from 'react'
import { Plus, Trash2, Pencil, Loader2, Monitor, Zap } from 'lucide-react'
import type { AgentDefinition } from '@shared/agent-definition'

interface DefinitionsTabProps {
  definitions: AgentDefinition[]
  saving: boolean
  onCreate: (draft: Omit<AgentDefinition, 'id'>) => void
  onUpdate: (id: string, patch: Omit<AgentDefinition, 'id'>) => void
  onDelete: (id: string) => void
}

interface FormState {
  emoji: string
  name: string
  description: string
  systemPrompt: string
  useDesktop: boolean
  autoApprove: boolean
}

const EMPTY_FORM: FormState = {
  emoji: '🤖',
  name: '',
  description: '',
  systemPrompt: '',
  useDesktop: false,
  autoApprove: false,
}

/** Agent 定义 — 独立于模式体系的可复用后台执行角色 */
export function DefinitionsTab({ definitions, saving, onCreate, onUpdate, onDelete }: DefinitionsTabProps): React.ReactElement {
  const [editingId, setEditingId] = useState<string | null>(null)
  const [showForm, setShowForm] = useState(false)
  const [form, setForm] = useState<FormState>(EMPTY_FORM)

  const openCreate = (): void => {
    setEditingId(null)
    setForm(EMPTY_FORM)
    setShowForm(true)
  }

  const openEdit = (def: AgentDefinition): void => {
    setEditingId(def.id)
    setForm({
      emoji: def.emoji, name: def.name, description: def.description,
      systemPrompt: def.systemPrompt,
      useDesktop: def.useDesktop, autoApprove: def.autoApprove,
    })
    setShowForm(true)
  }

  const submit = (): void => {
    if (!form.name.trim()) return
    if (editingId) onUpdate(editingId, { ...form })
    else onCreate({ ...form })
    setShowForm(false)
    setEditingId(null)
  }

  return (
    <div className="flex flex-col gap-2 p-3">
      <div className="flex items-center justify-between px-1">
        <p className="text-caption text-text-muted">定义一个可复用的执行角色 — 供实例与定时任务选用</p>
        <button
          onClick={openCreate}
          className="flex items-center gap-1 rounded-control bg-accent/15 px-2 py-1 text-xs text-accent hover:bg-accent/25"
        >
          {showForm && !editingId ? '收起' : <><Plus size={11} />新建</>}
        </button>
      </div>

      {showForm && (
        <div className="flex flex-col gap-2 rounded-card border border-border-subtle bg-bg-elevated-soft p-3">
          <div className="flex items-center gap-2">
            <input
              value={form.emoji}
              onChange={(e) => setForm((f) => ({ ...f, emoji: e.target.value.slice(0, 2) }))}
              className="w-12 rounded-control bg-bg-input border border-border-subtle px-2 py-1.5 text-center text-sm outline-none focus:border-accent/40"
            />
            <input
              value={form.name}
              onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
              placeholder="Agent 名称，如：数据分析员"
              className="min-w-0 flex-1 rounded-control bg-bg-input border border-border-subtle px-2 py-1.5 text-xs text-text-primary outline-none placeholder:text-text-quaternary focus:border-accent/40"
            />
          </div>
          <input
            value={form.description}
            onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
            placeholder="一句话定位，如：负责整理数据并生成可视化报告"
            className="rounded-control bg-bg-input border border-border-subtle px-2 py-1.5 text-xs text-text-primary outline-none placeholder:text-text-quaternary focus:border-accent/40"
          />
          <textarea
            value={form.systemPrompt}
            onChange={(e) => setForm((f) => ({ ...f, systemPrompt: e.target.value }))}
            placeholder="职责指令（可选）：工作方式、输出要求、注意事项…"
            rows={3}
            className="resize-none rounded-control bg-bg-input border border-border-subtle px-2 py-1.5 text-xs text-text-primary outline-none placeholder:text-text-quaternary focus:border-accent/40"
          />
          <label className="flex items-center gap-1.5 text-caption text-text-secondary">
            <input type="checkbox" checked={form.useDesktop} onChange={(e) => setForm((f) => ({ ...f, useDesktop: e.target.checked }))} />
            <Monitor size={11} />
            在隔离桌面中执行
          </label>
          <label className="flex items-center gap-1.5 text-caption text-text-secondary">
            <input type="checkbox" checked={form.autoApprove} onChange={(e) => setForm((f) => ({ ...f, autoApprove: e.target.checked }))} />
            <Zap size={11} />
            后台免审批（yolo）— 关闭时需确认的操作将被自动拒绝并记录
          </label>
          <button
            onClick={submit}
            disabled={saving || !form.name.trim()}
            className="flex items-center justify-center gap-1.5 rounded-control bg-accent px-2 py-1.5 text-xs text-white transition-colors hover:bg-accent/85 disabled:opacity-40"
          >
            {saving ? <Loader2 size={11} className="animate-spin" /> : null}
            {editingId ? '保存修改' : '创建 Agent 定义'}
          </button>
        </div>
      )}

      {definitions.map((def) => (
        <div key={def.id} className="flex items-center gap-2 rounded-card border border-border-subtle bg-bg-elevated-soft px-3 py-2">
          <span className="shrink-0 text-base">{def.emoji}</span>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-1.5">
              <span className="truncate text-xs font-medium text-text-primary">{def.name}</span>
              {def.useDesktop && (
                <span className="flex shrink-0 items-center gap-0.5 text-caption text-accent">
                  <Monitor size={9} />桌面
                </span>
              )}
              {def.autoApprove && (
                <span className="flex shrink-0 items-center gap-0.5 text-caption text-state-warning">
                  <Zap size={9} />免审批
                </span>
              )}
            </div>
            <p className="truncate text-caption text-text-muted">{def.description || def.systemPrompt || '—'}</p>
          </div>
          <button
            onClick={() => openEdit(def)}
            className="icon-btn shrink-0 rounded-control p-1 text-text-muted hover:text-accent"
            title="编辑"
          >
            <Pencil size={12} />
          </button>
          <button
            onClick={() => onDelete(def.id)}
            className="icon-btn shrink-0 rounded-control p-1 text-text-muted hover:text-state-error"
            title="删除"
          >
            <Trash2 size={12} />
          </button>
        </div>
      ))}
    </div>
  )
}
