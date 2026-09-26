import type { AgentSessionSummary, ProjectSummary, SceneSnapshot } from './types'

export function chooseInitialProject(
  projects: ProjectSummary[],
  rememberedProjectId: string | null,
  preferredProjectId: string | null = null,
): ProjectSummary | null {
  const preferred = projects.find((project) => (
    project.id === preferredProjectId && project.available
  ))
  const remembered = projects.find((project) => (
    project.id === rememberedProjectId && project.available
  ))
  return preferred ?? remembered ?? projects.find((project) => project.isScratch) ?? null
}

export function chooseProjectScene(
  diskScene: SceneSnapshot | null,
  localScene: SceneSnapshot | null,
): SceneSnapshot | null {
  return diskScene ?? localScene
}

export function hasSceneContent(scene: SceneSnapshot | null): boolean {
  return Boolean(scene?.elements.some((element) => (
    !element || typeof element !== 'object' || !('isDeleted' in element) || element.isDeleted !== true
  )))
}

export async function loadProjectAfterFlush<T>(
  flushCurrentProject: () => Promise<void>,
  loadTargetProject: () => Promise<T>,
): Promise<T> {
  await flushCurrentProject()
  const target = await loadTargetProject()
  await flushCurrentProject()
  return target
}

export function formatSceneConflictMessage(recoveryPath: string | null): string {
  return recoveryPath
    ? `画布版本冲突。浏览器副本已保留，恢复快照：${recoveryPath}。磁盘自动保存已暂停，请切换项目或重新加载。`
    : '画布版本冲突。浏览器副本已保留，磁盘自动保存已暂停，请切换项目或重新加载。'
}

export function clearMatchingDiskError(
  currentError: string | null,
  trackedDiskError: string | null,
): string | null {
  return trackedDiskError !== null && currentError === trackedDiskError
    ? null
    : currentError
}

export interface SessionSelection {
  id: string | null
  source: 'auto' | 'manual' | null
}

export function reconcileSessionSelection(
  sessions: AgentSessionSummary[],
  current: SessionSelection,
): SessionSelection {
  if (current.id && !sessions.some(session => session.id === current.id)) return current
  if (sessions.length === 0) return { id: null, source: null }
  if (sessions.length === 1) {
    if (current.source === 'manual' && current.id === sessions[0].id) return current
    return { id: sessions[0].id, source: 'auto' }
  }
  return current.source === 'manual'
    && sessions.some((session) => session.id === current.id)
    ? current
    : { id: null, source: null }
}

export interface SubmissionAttemptInput {
  projectId: string
  sceneGeneration: number
  note: string
  targetSessionId: string | null
}

export interface SubmissionAttempt extends SubmissionAttemptInput {
  clientSubmissionId: string
}

function matchesInput(
  attempt: SubmissionAttempt,
  input: SubmissionAttemptInput,
): boolean {
  return attempt.projectId === input.projectId
    && attempt.sceneGeneration === input.sceneGeneration
    && attempt.note === input.note
    && attempt.targetSessionId === input.targetSessionId
}

export function nextSubmissionAttempt(
  current: SubmissionAttempt | null,
  input: SubmissionAttemptInput,
  createId: () => string = createClientSubmissionId,
): SubmissionAttempt {
  if (current && matchesInput(current, input)) return current
  return { ...input, clientSubmissionId: createId() }
}

export function createClientSubmissionId(
  now = new Date(),
  randomUUID: () => string = () => crypto.randomUUID(),
): string {
  const timestamp = now.toISOString().replace(/[-:.]/g, '')
  return `${timestamp}-${randomUUID()}`
}
