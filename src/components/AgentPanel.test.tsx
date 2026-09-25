import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { AgentSessionSummary, ProjectSummary } from '../bridge/types'
import { AgentPanel, type AgentPanelProps } from './AgentPanel'

const projects: ProjectSummary[] = [
  {
    id: 'scratch',
    name: '临时画板',
    rootPath: 'C:\\Users\\tester\\AppData\\Local\\ExcalidrawAgentBridge\\scratch',
    available: true,
    isScratch: true,
  },
]

const session: AgentSessionSummary = {
  id: 'session-1',
  projectId: 'scratch',
  label: 'Codex：登录流程讨论',
  createdAt: '2026-07-12T12:00:00.000Z',
  expiresAt: '2026-07-12T12:05:00.000Z',
}

const noop = () => undefined

function render(overrides: Partial<AgentPanelProps> = {}) {
  return renderToStaticMarkup(
    <AgentPanel
      projects={projects}
      currentProjectId="scratch"
      sessions={[]}
      selectedSessionId={null}
      note=""
      busy={false}
      canvasEmpty={false}
      lastResult={null}
      error={null}
      onProjectChange={noop}
      onAddProject={noop}
      onRenameProject={noop}
      onSessionChange={noop}
      onNoteChange={noop}
      onSubmit={noop}
      {...overrides}
    />,
  )
}

describe('AgentPanel', () => {
  it('renders the exact offline copy, project path, and enabled submission action', () => {
    const html = render()

    expect(html).toContain('未连接，发送后进入待处理箱')
    expect(html).toContain('发送当前画板')
    expect(html).toContain('C:\\Users\\tester\\AppData\\Local\\ExcalidrawAgentBridge\\scratch')
    expect(html).toContain('maxLength="4000"')
    expect(html).not.toMatch(/<button[^>]*disabled=""[^>]*>发送当前画板<\/button>/)
  })

  it('renders online and received status copy with a polite live region', () => {
    const html = render({
      sessions: [session],
      selectedSessionId: 'session-1',
      lastResult: {
        submissionId: 'submission-received-1',
        status: 'received',
        submittedAt: '2026-07-12T12:01:00.000Z',
        sceneRevision: 3,
      },
    })

    expect(html).toContain('Agent 正在等待')
    expect(html).toContain('已发送，Agent 正在处理')
    expect(html).toContain('aria-live="polite"')
  })

  it('renders pending status copy and disables submission for an empty or busy canvas', () => {
    const pending = render({
      canvasEmpty: true,
      lastResult: {
        submissionId: 'submission-pending-1',
        status: 'pending',
        submittedAt: '2026-07-12T12:01:00.000Z',
        sceneRevision: 3,
      },
    })
    const busy = render({ busy: true })

    expect(pending).toContain('已保存到待处理箱，Agent 尚未读取')
    expect(pending).toMatch(/<button[^>]*disabled=""[^>]*>发送当前画板<\/button>/)
    expect(busy).toMatch(/<button[^>]*disabled=""[^>]*>发送当前画板<\/button>/)
  })

  it('requires an explicit target when multiple sessions are waiting', () => {
    const one = render({ sessions: [session] })
    const many = render({
      sessions: [session, { ...session, id: 'session-2', label: 'Claude' }],
    })
    const selected = render({
      sessions: [session, { ...session, id: 'session-2', label: 'Claude' }],
      selectedSessionId: 'session-2',
    })

    expect(one).not.toContain('发送给')
    expect(many).toContain('发送给')
    expect(many).toContain('请选择 Agent')
    expect(many).toMatch(/<button[^>]*disabled=""[^>]*>发送当前画板<\/button>/)
    expect(selected).not.toMatch(/<button[^>]*disabled=""[^>]*>发送当前画板<\/button>/)
  })

  it('surfaces errors in the polite status region', () => {
    const html = render({ error: '画布冲突。恢复快照：C:\\recovery\\scene.excalidraw' })

    expect(html).toContain('画布冲突。恢复快照：C:\\recovery\\scene.excalidraw')
    expect(html).toContain('role="status"')
  })

  it('keeps the polite live region outside the collapsible body', () => {
    const html = render()

    expect(html).toMatch(/<\/div><p class="agent-panel__live" role="status" aria-live="polite"/)
  })

  it('changes polite live content for consecutive submissions with the same status', () => {
    const first = render({
      lastResult: {
        submissionId: 'submission-1',
        status: 'received',
        submittedAt: '2026-07-12T12:01:00.000Z',
        sceneRevision: 3,
      },
    })
    const second = render({
      lastResult: {
        submissionId: 'submission-2',
        status: 'received',
        submittedAt: '2026-07-12T12:01:00.000Z',
        sceneRevision: 3,
      },
    })

    expect(first).toContain('<span class="agent-panel__sr-only">提交 submission-1</span>')
    expect(second).toContain('<span class="agent-panel__sr-only">提交 submission-2</span>')
    expect(second).not.toBe(first)
  })
})
