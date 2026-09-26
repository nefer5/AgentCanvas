import { useState, type ReactNode } from 'react'
import { InterfaceIcon } from './InterfaceIcon'
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
  management?: ReactNode
  bound?: boolean
  boardName?: string
  conversation?: string | null
  onBrowseBoards?(): void
  elementCount?: number
  revision?: number
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

function bindingLabel(conversation: string) {
  const match = /^(codex|opencode):(.+)$/i.exec(conversation)
  if (!match) return conversation
  return `${match[1].toLowerCase() === 'codex' ? 'Codex' : 'OpenCode'} · 会话 ${match[2].slice(0, 8)}`
}

export function AgentPanel({
  management, bound = false, boardName, conversation = null, onBrowseBoards, elementCount = 0, revision = 0,
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
  const staleTarget = Boolean(selectedSessionId && !sessions.some(session => session.id === selectedSessionId))
  const targetRequired = !bound && (sessions.length > 1 && !selectedSessionId || staleTarget)
  const liveMessage = error ?? (lastResult ? resultCopy(lastResult.status) : '')

  return (
    <aside
      className={`agent-panel${collapsed ? ' agent-panel--collapsed' : ''}`}
      aria-label="Agent 画板发送面板"
    >
      <header className="agent-panel__header">
        <span className={`agent-panel__mark${error ? ' has-error' : ''}`} title={error ?? undefined}><InterfaceIcon name="canvas" /></span>
        <div className="agent-panel__heading"><h1 title={boardName ?? 'AgentCanvas'}>{boardName ?? 'AgentCanvas'}</h1><p>画板协作 <span>·</span> 本地工作空间</p></div>
        <button
          className="agent-panel__collapse"
          type="button"
          aria-expanded={!collapsed}
          aria-controls="agent-panel-body"
          onClick={() => setCollapsed((value) => !value)}
        >
          <span>{collapsed ? '展开' : '收起'}</span><InterfaceIcon name="chevron" />
        </button>
        <div className={`chat-binding ${conversation ? 'chat-binding--bound' : 'chat-binding--unbound'}`} aria-label="聊天绑定" title={conversation ?? '未绑定聊天'}>
          <InterfaceIcon name="link" />
          <span className="chat-binding__copy"><small>当前绑定</small><strong>{conversation ? bindingLabel(conversation) : '未绑定聊天'}</strong></span>
          <span className="chat-binding__compact">{conversation ? '已绑定' : '未绑定聊天'}</span>
        </div>
      </header>

      <div id="agent-panel-body" className="agent-panel__body" hidden={collapsed}>
        <section className="workspace-card" aria-label={bound ? '所属工作区' : '当前工作区'}>
        <div className="panel-section-heading"><span>{bound ? '所属工作区' : '当前工作区'}</span><span className="binding-tag">{bound ? '画板归属' : '项目画板'}</span></div>
        {bound ? <div className="workspace-readonly"><InterfaceIcon name="folder" /><strong>{currentProject?.name ?? '项目不可用'}</strong></div> : <label className="agent-panel__field">
          <span className="agent-panel__sr-only">项目</span>
          <select
            value={currentProjectId}
            disabled={busy || bound}
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
        </label>}

        {!bound && <div className="agent-panel__project-actions">
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
        </div>}

        <p
          className="agent-panel__path"
          title={currentProject?.rootPath ?? '未选择项目'}
        >
          <InterfaceIcon name="folder" /><span>{currentProject?.rootPath ?? '未选择项目'}</span>
        </p>
        {bound && <button className="workspace-browse" type="button" onClick={onBrowseBoards}><InterfaceIcon name="history" />打开其他画板<InterfaceIcon name="chevron" /></button>}

        <p className={`agent-panel__connection agent-panel__connection--${online ? 'online' : 'offline'}`}>
          <span className="agent-panel__status-dot" aria-hidden="true" />
          <span>{online ? ONLINE_COPY : OFFLINE_COPY}</span>
        </p>
        </section>

        {(sessions.length > 1 || staleTarget) && !bound ? (
          <label className="agent-panel__field">
            <span>发送给</span>
            <select
              value={selectedSessionId ?? ''}
              disabled={busy}
              onChange={(event) => onSessionChange(event.target.value || null)}
            >
              <option value="" disabled>请选择 Agent</option>
              {staleTarget && <option value={selectedSessionId ?? ''}>原接收者已离线，请明确重新选择</option>}
              {sessions.map((session) => (
                <option key={session.id} value={session.id}>
                  {formatSession(session)}
                </option>
              ))}
            </select>
          </label>
        ) : null}

        <section className="scene-overview" aria-label="画面概览">
          <div className="panel-section-heading"><span><InterfaceIcon name="overview" />画面概览</span><span className="overview-count">{elementCount} 个元素</span></div>
          <p>{canvasEmpty ? '从工具栏开始绘制，或导入已有画板。' : '图形与说明将作为一次完整提交，保留给当前接收目标。'}</p>
          <span className="scene-revision" title="本画板内部的内容保存版本，不是画板识别号">内容版本 <b>{revision}</b></span>
        </section>
        <label className="agent-panel__field agent-composer">
          <span className="composer-heading"><span>给 Agent 的说明 <small>可选</small></span><span className="agent-panel__counter">{note.length} / 4000</span></span>
          <textarea
            aria-label="给 Agent 的说明（可选）"
            value={note}
            maxLength={4000}
            rows={4}
            disabled={busy}
            placeholder="说明你希望关注的部分，或下一步要完成的事情…"
            onChange={(event) => onNoteChange(event.target.value)}
          />
          <span className="composer-footer">画面与说明一起发送 <kbd>Ctrl ↵</kbd></span>
        </label>

        <button
          className="agent-panel__submit"
          type="button"
          disabled={canvasEmpty || busy || targetRequired}
          aria-busy={busy}
          onClick={() => void onSubmit()}
        >
          <InterfaceIcon name="send" />发送当前画板
        </button>

        {lastResult ? (
          <p className="agent-panel__last-result">
            最近提交：{formatSubmittedAt(lastResult.submittedAt)} · 版本 {lastResult.sceneRevision} ·{' '}
            {resultCopy(lastResult.status)}
          </p>
        ) : null}
      </div>
      {management}
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
