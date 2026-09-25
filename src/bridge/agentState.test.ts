import { describe, expect, it } from 'vitest'
import type { AgentSessionSummary } from './types'
import {
  chooseInitialProject,
  chooseProjectScene,
  clearMatchingDiskError,
  createClientSubmissionId,
  formatSceneConflictMessage,
  hasSceneContent,
  loadProjectAfterFlush,
  nextSubmissionAttempt,
  reconcileSessionSelection,
  type SessionSelection,
  type SubmissionAttempt,
} from './agentState'

function session(id: string): AgentSessionSummary {
  return {
    id,
    projectId: 'project-a',
    label: `Session ${id}`,
    createdAt: '2026-07-12T12:00:00.000Z',
    expiresAt: '2026-07-12T12:05:00.000Z',
  }
}

describe('agent session selection', () => {
  const none: SessionSelection = { id: null, source: null }

  it('clears any target when no sessions are waiting', () => {
    expect(reconcileSessionSelection([], {
      id: 'session-1',
      source: 'manual',
    })).toEqual(none)
  })

  it('automatically selects the sole waiting session and records its provenance', () => {
    expect(reconcileSessionSelection([session('session-1')], none)).toEqual({
      id: 'session-1',
      source: 'auto',
    })
  })

  it('clears an auto-selected sole session when the list grows to multiple sessions', () => {
    const auto = reconcileSessionSelection([session('session-1')], none)

    expect(reconcileSessionSelection([
      session('session-1'),
      session('session-2'),
    ], auto)).toEqual(none)
  })

  it('retains a still-valid manual target across list shrink and growth', () => {
    const sessions = [session('session-1'), session('session-2')]
    const manual: SessionSelection = { id: 'session-2', source: 'manual' }

    expect(reconcileSessionSelection(sessions, manual)).toEqual(manual)
    expect(reconcileSessionSelection([session('session-2')], manual)).toEqual(manual)
    expect(reconcileSessionSelection(sessions, manual)).toEqual(manual)
  })

  it('clears a disappeared manual target when multiple sessions remain', () => {
    expect(reconcileSessionSelection([
      session('session-1'),
      session('session-2'),
    ], {
      id: 'expired-session',
      source: 'manual',
    })).toEqual(none)
  })

  it('auto-selects the new sole session after a manual target disappears', () => {
    expect(reconcileSessionSelection([session('session-1')], {
      id: 'expired-session',
      source: 'manual',
    })).toEqual({ id: 'session-1', source: 'auto' })
  })
})

describe('project scene selection', () => {
  const scratch = {
    id: 'scratch',
    name: '临时画板',
    rootPath: 'C:\\scratch',
    available: true,
    isScratch: true,
  }
  const project = {
    id: 'project-a',
    name: 'Project A',
    rootPath: 'E:\\Project A',
    available: true,
    isScratch: false,
  }

  it('restores a valid remembered project and otherwise falls back to scratch', () => {
    expect(chooseInitialProject([scratch, project], 'project-a')).toBe(project)
    expect(chooseInitialProject([scratch, { ...project, available: false }], 'project-a')).toBe(scratch)
    expect(chooseInitialProject([scratch, project], 'missing')).toBe(scratch)
  })

  it('prefers an Agent-supplied project over browser history', () => {
    expect(chooseInitialProject([scratch, project], null, 'project-a')).toBe(project)
    expect(chooseInitialProject([scratch, project], 'scratch', 'project-a')).toBe(project)
  })

  it('prefers the disk scene and only falls back to scoped local storage when disk is empty', () => {
    const disk = { ...sceneA, elements: [{ id: 'disk' }] }
    const local = { ...sceneA, elements: [{ id: 'local' }] }

    expect(chooseProjectScene(disk, local)).toBe(disk)
    expect(chooseProjectScene(null, local)).toBe(local)
    expect(chooseProjectScene(null, null)).toBeNull()
  })

  it('treats deleted-only scenes as empty', () => {
    expect(hasSceneContent(sceneA)).toBe(true)
    expect(hasSceneContent({ ...sceneA, elements: [{ id: 'gone', isDeleted: true }] })).toBe(false)
    expect(hasSceneContent(null)).toBe(false)
  })

  it('flushes the current scene before loading a target and drains late edits afterward', async () => {
    const events: string[] = []

    const loaded = await loadProjectAfterFlush(
      async () => { events.push('flush') },
      async () => {
        events.push('load')
        return 'target-scene'
      },
    )

    expect(loaded).toBe('target-scene')
    expect(events).toEqual(['flush', 'load', 'flush'])
  })

  it('keeps the recovery path in the paused conflict message', () => {
    expect(formatSceneConflictMessage('C:\\recovery\\scene.excalidraw')).toBe(
      '画布版本冲突。浏览器副本已保留，恢复快照：C:\\recovery\\scene.excalidraw。磁盘自动保存已暂停，请切换项目或重新加载。',
    )
  })
})

describe('disk error recovery', () => {
  const diskError = '画布磁盘保存失败：服务暂时不可用'

  it('clears the tracked disk error after a later successful flush', () => {
    expect(clearMatchingDiskError(diskError, diskError)).toBeNull()
  })

  it('preserves unrelated and conflict recovery messages', () => {
    expect(clearMatchingDiskError('项目改名失败：名称无效', diskError)).toBe(
      '项目改名失败：名称无效',
    )
    expect(clearMatchingDiskError(
      '画布版本冲突。恢复快照：C:\\recovery\\scene.excalidraw',
      diskError,
    )).toBe('画布版本冲突。恢复快照：C:\\recovery\\scene.excalidraw')
  })

  it('leaves the current error unchanged when no disk error is tracked', () => {
    expect(clearMatchingDiskError('Agent 会话查询失败', null)).toBe('Agent 会话查询失败')
  })
})

describe('submission attempts', () => {
  const input = {
    projectId: 'project-a',
    sceneGeneration: 7,
    note: '检查登录流程',
    targetSessionId: 'session-1',
  }

  it('retains one client id when retrying unchanged input after an ambiguous failure', () => {
    let generated = 0
    const createId = () => `submission-${++generated}`

    const first = nextSubmissionAttempt(null, input, createId)
    const retry = nextSubmissionAttempt(first, input, createId)

    expect(retry).toBe(first)
    expect(retry.clientSubmissionId).toBe('submission-1')
    expect(generated).toBe(1)
  })

  it('creates a fresh id when scene, note, target, or project changes', () => {
    let generated = 0
    const createId = () => `submission-${++generated}`
    let attempt: SubmissionAttempt | null = nextSubmissionAttempt(null, input, createId)

    for (const change of [
      { sceneGeneration: 8 },
      { note: '检查注册流程' },
      { targetSessionId: 'session-2' },
      { projectId: 'project-b' },
    ]) {
      attempt = nextSubmissionAttempt(attempt, { ...input, ...change }, createId)
    }

    expect(attempt.clientSubmissionId).toBe('submission-5')
    expect(generated).toBe(5)
  })

  it('creates a fresh id after success clears the previous attempt', () => {
    let generated = 0
    const createId = () => `submission-${++generated}`
    const first = nextSubmissionAttempt(null, input, createId)

    const afterSuccess = nextSubmissionAttempt(null, input, createId)

    expect(afterSuccess.clientSubmissionId).not.toBe(first.clientSubmissionId)
  })

  it('formats the UTC timestamp and random UUID into the client id', () => {
    expect(createClientSubmissionId(
      new Date('2026-07-12T12:34:56.789Z'),
      () => '123e4567-e89b-12d3-a456-426614174000',
    )).toBe('20260712T123456789Z-123e4567-e89b-12d3-a456-426614174000')
  })
})

const sceneA = {
  type: 'excalidraw' as const,
  version: 2 as const,
  source: 'http://127.0.0.1:4173',
  elements: [{ id: 'box-1' }],
  appState: {},
  files: {},
}
