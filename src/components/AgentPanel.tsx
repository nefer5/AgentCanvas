import { useState } from 'react'
import type {
  AgentSessionSummary,
  ProjectSummary,
  SubmissionResult,
} from '../bridge/types'

const ONLINE_COPY = 'Agent 正在等待'
const OFFLINE_COPY = '未连接，发送后进入待处理箱'
const RECEIVED_COPY = '已发送，Agent 正在处理'
const PENDING_COPY = '已保存到待处理箱，Agent 尚未读取'

export interface PanelSubmissionResult {
  submissionId: string
  status: SubmissionResult['status']
  submittedAt: string
  sceneRevision: number
}

export interface AgentPanelProps {
  projects: ProjectSummary[]
  currentProjectId: string
  sessions: AgentSessionSummary[]
  selectedSessionId: string | null
  note: string
  busy: boolean
  canvasEmpty: boolean
  lastResult: PanelSubmissionResult | null
  error: string | null
  onProjectChange(projectId: string): void | Promise<void>
  onAddProject(): void | Promise<void>
  onRenameProject(): void | Promise<void>
  onSessionChange(sessionId: string | null): void
  onNoteChange(note: string): void
  onSubmit(): void | Promise<void>
}

function startsCollapsed(): boolean {
  return typeof window !== 'undefined'
    && typeof window.matchMedia === 'function'
    && window.matchMedia('(max-width: 639px)').matches
}

function resultCopy(status: SubmissionResult['status']): string {
  return status === 'received' ? RECEIVED_COPY : PENDING_COPY
}

function formatSubmittedAt(value: string): string {
  const date = new Date(value)
  return Number.isNaN(date.valueOf()) ? value : date.toLocaleString('zh-CN')
}

function formatSession(session: AgentSessionSummary): string {
  const created = new Date(session.createdAt)
  if (Number.isNaN(created.valueOf())) return `${session.label}（${session.createdAt}）`
  const elapsedMinutes = Math.max(0, Math.floor((Date.now() - created.valueOf()) / 60_000))
  const age = elapsedMinutes < 1
    ? '刚刚'
    : elapsedMinutes < 60
      ? `${elapsedMinutes} 分钟前`
      : created.toLocaleString('zh-CN')
  return `${session.label}（${age}）`
}

export function AgentPanel({
  projects,
  currentProjectId,
  sessions,
  selectedSessionId,
  note,
  busy,
  canvasEmpty,
  lastResult,
  error,
  onProjectChange,
  onAddProject,
  onRenameProject,
  onSessionChange,
  onNoteChange,
  onSubmit,
}: AgentPanelProps) {
  const [collapsed, setCollapsed] = useState(startsCollapsed)
  const currentProject = projects.find((project) => project.id === currentProjectId)
  const online = sessions.length > 0
  const targetRequired = sessions.length > 1 && !selectedSessionId
  const liveMessage = error ?? (lastResult ? resultCopy(lastResult.status) : '')

  return (
    <aside
      className={`agent-panel${collapsed ? ' agent-panel--collapsed' : ''}`}
      aria-label="Agent 画板发送面板"
    >
      <header className="agent-panel__header">
        <h1>Agent</h1>
        <button
          className="agent-panel__collapse"
          type="button"
          aria-expanded={!collapsed}
          aria-controls="agent-panel-body"
          onClick={() => setCollapsed((value) => !value)}
        >
          {collapsed ? '展开' : '收起'}
        </button>
      </header>

      <div id="agent-panel-body" className="agent-panel__body" hidden={collapsed}>
        <label className="agent-panel__field">
          <span>项目</span>
          <select
            value={currentProjectId}
            disabled={busy}
            onChange={(event) => void onProjectChange(event.target.value)}
          >
            {projects.map((project) => (
              <option
                key={project.id}
                value={project.id}
                disabled={!project.available && project.id !== currentProjectId}
              >
                {project.name}{project.available ? '' : '（不可用）'}
              </option>
            ))}
          </select>
        </label>

        <div className="agent-panel__project-actions">
          <button type="button" disabled={busy} onClick={() => void onAddProject()}>
            添加项目
          </button>
          <button
            type="button"
            disabled={busy || !currentProject || currentProject.isScratch}
            onClick={() => void onRenameProject()}
          >
            改名
          </button>
        </div>

        <p
          className="agent-panel__path"
          title={currentProject?.rootPath ?? '未选择项目'}
        >
          {currentProject?.rootPath ?? '未选择项目'}
        </p>

        <p className={`agent-panel__connection agent-panel__connection--${online ? 'online' : 'offline'}`}>
          <span className="agent-panel__status-dot" aria-hidden="true" />
          <span>{online ? ONLINE_COPY : OFFLINE_COPY}</span>
        </p>

        {sessions.length > 1 ? (
          <label className="agent-panel__field">
            <span>发送给</span>
            <select
              value={selectedSessionId ?? ''}
              disabled={busy}
              onChange={(event) => onSessionChange(event.target.value || null)}
            >
              <option value="" disabled>请选择 Agent</option>
              {sessions.map((session) => (
                <option key={session.id} value={session.id}>
                  {formatSession(session)}
                </option>
              ))}
            </select>
          </label>
        ) : null}

        <label className="agent-panel__field">
          <span>给 Agent 的说明（可选）</span>
          <textarea
            value={note}
            maxLength={4000}
            rows={4}
            disabled={busy}
            onChange={(event) => onNoteChange(event.target.value)}
          />
          <span className="agent-panel__counter">{note.length} / 4000</span>
        </label>

        <button
          className="agent-panel__submit"
          type="button"
          disabled={canvasEmpty || busy || targetRequired}
          aria-busy={busy}
          onClick={() => void onSubmit()}
        >
          发送当前画板
        </button>

        {lastResult ? (
          <p className="agent-panel__last-result">
            最近提交：{formatSubmittedAt(lastResult.submittedAt)} · 版本 {lastResult.sceneRevision} ·{' '}
            {resultCopy(lastResult.status)}
          </p>
        ) : null}
      </div>
      <p
        className={`agent-panel__live${error ? ' agent-panel__live--error' : ''}${collapsed ? ' agent-panel__live--collapsed' : ''}`}
        role="status"
        aria-live="polite"
        aria-atomic="true"
      >
        {liveMessage}
        {!error && lastResult ? (
          <span className="agent-panel__sr-only">提交 {lastResult.submissionId}</span>
        ) : null}
      </p>
    </aside>
  )
}
