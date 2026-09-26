import type {
  AgentSessionSummary,
  BridgeClient,
  ProjectSummary,
  SceneDocument,
  SceneSnapshot,
  SceneSubmission,
  SubmissionResult,
} from './types'

interface ErrorEnvelope {
  error: {
    code: string
    message: string
    details?: unknown
  }
}

export class BridgeApiError extends Error {
  readonly status: number
  readonly code: string
  readonly details: unknown

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message)
    this.name = 'BridgeApiError'
    this.status = status
    this.code = code
    this.details = details
  }
}

function isErrorEnvelope(value: unknown): value is ErrorEnvelope {
  if (!value || typeof value !== 'object') return false
  const error = (value as { error?: unknown }).error
  if (!error || typeof error !== 'object') return false
  const candidate = error as { code?: unknown; message?: unknown }
  return typeof candidate.code === 'string' && typeof candidate.message === 'string'
}

function fallbackHttpMessage(response: Response, body: string): string {
  const responseBody = body.trim()
  const status = response.statusText
    ? `${response.status} ${response.statusText}`
    : String(response.status)
  return responseBody
    ? `Request failed (${status}): ${responseBody.slice(0, 500)}`
    : `Request failed (${status})`
}

async function requestJson<T>(
  fetchImpl: typeof fetch,
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const headers = new Headers(init.headers)
  if (init.body !== undefined && init.body !== null && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json')
  }

  const response = await fetchImpl(path, { ...init, signal: init.signal ?? AbortSignal.timeout(15_000), headers })
  const body = await response.text()
  let parsed: unknown
  let malformed = false

  try {
    parsed = JSON.parse(body)
  } catch {
    malformed = true
  }

  if (!response.ok) {
    if (!malformed && isErrorEnvelope(parsed)) {
      throw new BridgeApiError(
        response.status,
        parsed.error.code,
        parsed.error.message,
        parsed.error.details,
      )
    }
    throw new BridgeApiError(
      response.status,
      'HTTP_ERROR',
      fallbackHttpMessage(response, body),
      body || undefined,
    )
  }

  if (malformed || parsed === null) {
    throw new BridgeApiError(
      response.status,
      'INVALID_RESPONSE',
      `Server returned invalid JSON: ${body.slice(0, 500)}`,
      body,
    )
  }

  return parsed as T
}

export function createBridgeClient(
  fetchImpl: typeof fetch = window.fetch.bind(window),
  boardId: string | null = null,
): BridgeClient {
  const scenePath = (projectId: string) => boardId
    ? `/api/boards/${encodeURIComponent(boardId)}/scene`
    : `/api/projects/${encodeURIComponent(projectId)}/scene`
  return {
    async listProjects() {
      const result = await requestJson<{ projects: ProjectSummary[] }>(
        fetchImpl,
        '/api/projects',
        { cache: 'no-store' },
      )
      return result.projects
    },

    async selectProjectDirectory() {
      const result = await requestJson<{ project: ProjectSummary | null }>(
        fetchImpl,
        '/api/projects/select-folder',
        { method: 'POST' },
      )
      return result.project
    },

    async registerProjectDirectory(rootPath) {
      const result = await requestJson<{ project: ProjectSummary }>(
        fetchImpl,
        '/api/projects/register',
        { method: 'POST', body: JSON.stringify({ rootPath }) },
      )
      return result.project
    },

    async renameProject(projectId, name) {
      const result = await requestJson<{ project: ProjectSummary }>(
        fetchImpl,
        `/api/projects/${encodeURIComponent(projectId)}`,
        { method: 'PATCH', body: JSON.stringify({ name }) },
      )
      return result.project
    },

    loadScene(projectId) {
      return requestJson<SceneDocument>(
        fetchImpl,
        scenePath(projectId),
        { cache: 'no-store' },
      )
    },

    saveScene(projectId, scene: SceneSnapshot, baseRevision) {
      return requestJson<Omit<SceneDocument, 'scene'>>(
        fetchImpl,
        scenePath(projectId),
        {
          method: 'PUT',
          body: JSON.stringify({ scene, baseRevision }),
        },
      )
    },

    async listAgentSessions(projectId) {
      if (boardId) {
        const status = await requestJson<{ receiverOnline: boolean; board: { conversation: string | null }; checkedAt: string }>(fetchImpl, `/api/boards/${encodeURIComponent(boardId)}/status`)
        return status.receiverOnline ? [{ id: boardId, projectId, label: status.board.conversation ?? '当前画板接收者', createdAt: status.checkedAt, expiresAt: status.checkedAt }] : []
      }
      const result = await requestJson<{ sessions: AgentSessionSummary[] }>(
        fetchImpl,
        `/api/projects/${encodeURIComponent(projectId)}/agent-sessions`,
        { cache: 'no-store' },
      )
      return result.sessions
    },

    submitScene(projectId, submission: SceneSubmission) {
      return requestJson<SubmissionResult>(
        fetchImpl,
        boardId ? `/api/boards/${encodeURIComponent(boardId)}/submissions` : `/api/projects/${encodeURIComponent(projectId)}/submissions`,
        { method: 'POST', body: JSON.stringify(submission) },
      )
    },
  }
}

export type { BridgeClient } from './types'
