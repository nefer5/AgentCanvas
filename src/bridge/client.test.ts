import { describe, expect, it } from 'vitest'
import { BridgeApiError, createBridgeClient } from './client'
import type {
  AgentSessionSummary,
  ProjectSummary,
  SceneDocument,
  SceneSubmission,
  SubmissionResult,
} from './types'

const scene = {
  type: 'excalidraw' as const,
  version: 2 as const,
  source: 'http://127.0.0.1:4173',
  elements: [{ id: 'box-1', type: 'rectangle' }],
  appState: { theme: 'light' },
  files: {},
}

const project: ProjectSummary = {
  id: 'project-a',
  name: 'Project A',
  rootPath: 'E:\\Project A',
  available: true,
  isScratch: false,
}

const projectRecord = {
  ...project,
  canvasDir: 'E:\\Project A\\.agent-canvas',
}

const sceneDocument: SceneDocument = {
  scene,
  revision: 4,
  updatedAt: '2026-07-12T12:00:00.000Z',
}

const session: AgentSessionSummary = {
  id: 'session-1',
  projectId: 'project-a',
  label: 'Codex',
  createdAt: '2026-07-12T12:00:00.000Z',
  expiresAt: '2026-07-12T12:01:00.000Z',
}

const submission: SceneSubmission = {
  scene,
  svg: '<svg/>',
  pngDataUrl: 'data:image/png;base64,cG5n',
  note: '检查流程',
  targetSessionId: 'session-1',
  sceneRevision: 4,
  clientSubmissionId: '20260712T120000000Z-client-test',
}

interface CapturedRequest {
  input: RequestInfo | URL
  init?: RequestInit
}

function captureJsonResponse<T>(body: T) {
  const requests: CapturedRequest[] = []
  const fetchImpl: typeof fetch = async (input, init) => {
    requests.push({ input, init })
    return Response.json(body)
  }
  return { requests, fetchImpl }
}

function requestHeaders(request: CapturedRequest) {
  return new Headers(request.init?.headers)
}

describe('browser bridge client', () => {
  it('lists projects from a same-origin no-store request', async () => {
    const { requests, fetchImpl } = captureJsonResponse({ projects: [projectRecord] })

    const result = await createBridgeClient(fetchImpl).listProjects()

    expect(result).toEqual([projectRecord])
    expect(requests[0]).toMatchObject({ input: '/api/projects' })
    expect(requests[0].init).toMatchObject({ cache: 'no-store' })
    expect(requestHeaders(requests[0]).has('Content-Type')).toBe(false)
  })

  it('selects a project directory without sending an empty JSON body', async () => {
    const { requests, fetchImpl } = captureJsonResponse({ project: projectRecord })

    const result = await createBridgeClient(fetchImpl).selectProjectDirectory()

    expect(result).toEqual(projectRecord)
    expect(requests[0]).toMatchObject({ input: '/api/projects/select-folder' })
    expect(requests[0].init).toMatchObject({ method: 'POST' })
    expect(requests[0].init?.body).toBeUndefined()
    expect(requestHeaders(requests[0]).has('Content-Type')).toBe(false)
  })

  it('registers an Agent project root with a JSON body', async () => {
    const { requests, fetchImpl } = captureJsonResponse({ project: projectRecord })

    const result = await createBridgeClient(fetchImpl).registerProjectDirectory('E:\\Project A')

    expect(result).toEqual(projectRecord)
    expect(requests[0]).toMatchObject({ input: '/api/projects/register' })
    expect(requests[0].init).toMatchObject({ method: 'POST' })
    expect(requestHeaders(requests[0]).get('Content-Type')).toBe('application/json')
    expect(JSON.parse(String(requests[0].init?.body))).toEqual({ rootPath: 'E:\\Project A' })
  })

  it('returns null when project directory selection is cancelled', async () => {
    const { fetchImpl } = captureJsonResponse({ project: null })

    await expect(createBridgeClient(fetchImpl).selectProjectDirectory()).resolves.toBeNull()
  })

  it('renames an encoded project path with a JSON body', async () => {
    const renamedProject = { ...projectRecord, name: 'Renamed' }
    const { requests, fetchImpl } = captureJsonResponse({ project: renamedProject })

    const result = await createBridgeClient(fetchImpl).renameProject('project / 北', 'Renamed')

    expect(result.name).toBe('Renamed')
    expect(requests[0]).toMatchObject({ input: '/api/projects/project%20%2F%20%E5%8C%97' })
    expect(requests[0].init).toMatchObject({ method: 'PATCH' })
    expect(requestHeaders(requests[0]).get('Content-Type')).toBe('application/json')
    expect(JSON.parse(String(requests[0].init?.body))).toEqual({ name: 'Renamed' })
  })

  it('loads a scene by encoded project id without cache', async () => {
    const { requests, fetchImpl } = captureJsonResponse(sceneDocument)

    const result = await createBridgeClient(fetchImpl).loadScene('project/a')

    expect(result).toEqual(sceneDocument)
    expect(requests[0]).toMatchObject({ input: '/api/projects/project%2Fa/scene' })
    expect(requests[0].init).toMatchObject({ cache: 'no-store' })
    expect(requestHeaders(requests[0]).has('Content-Type')).toBe(false)
  })

  it('saves a scene with its base revision', async () => {
    const saved = { revision: 5, updatedAt: '2026-07-12T12:01:00.000Z' }
    const { requests, fetchImpl } = captureJsonResponse(saved)

    const result = await createBridgeClient(fetchImpl).saveScene('project/a', scene, 4)

    expect(result).toEqual(saved)
    expect(requests[0]).toMatchObject({ input: '/api/projects/project%2Fa/scene' })
    expect(requests[0].init).toMatchObject({ method: 'PUT' })
    expect(requestHeaders(requests[0]).get('Content-Type')).toBe('application/json')
    expect(JSON.parse(String(requests[0].init?.body))).toEqual({ scene, baseRevision: 4 })
  })

  it('lists agent sessions by encoded project id without cache', async () => {
    const { requests, fetchImpl } = captureJsonResponse({ sessions: [session] })

    const result = await createBridgeClient(fetchImpl).listAgentSessions('project/a')

    expect(result).toEqual([session])
    expect(requests[0]).toMatchObject({
      input: '/api/projects/project%2Fa/agent-sessions',
      init: { cache: 'no-store' },
    })
    expect(requestHeaders(requests[0]).has('Content-Type')).toBe(false)
  })

  it('submits the target session and note to an encoded project path', async () => {
    const response = {
      submissionId: 'sub-1',
      status: 'received',
      projectId: 'project-a',
      projectRoot: 'E:\\Project A',
      scenePath: 'scene.excalidraw',
      svgPath: 'preview.svg',
      pngPath: 'preview.png',
      note: '检查流程',
    } satisfies SubmissionResult & {
      projectId: string
      projectRoot: string
      note: string
    }
    const { requests, fetchImpl } = captureJsonResponse(response)

    const result = await createBridgeClient(fetchImpl).submitScene('project/a', submission)

    expect(result).toEqual(response)
    expect(requests[0]).toMatchObject({ input: '/api/projects/project%2Fa/submissions' })
    expect(requests[0].init).toMatchObject({ method: 'POST' })
    expect(requestHeaders(requests[0]).get('Content-Type')).toBe('application/json')
    expect(JSON.parse(String(requests[0].init?.body))).toEqual(submission)
  })

  it('turns structured HTTP errors into BridgeApiError', async () => {
    const client = createBridgeClient(async () => Response.json({
      error: {
        code: 'SCENE_CONFLICT',
        message: '冲突',
        details: { currentRevision: 2 },
      },
    }, { status: 409 }))

    await expect(client.saveScene('project-a', scene, 1)).rejects.toMatchObject({
      name: 'BridgeApiError',
      status: 409,
      code: 'SCENE_CONFLICT',
      message: '冲突',
      details: { currentRevision: 2 },
    })
  })

  it('turns non-JSON HTTP failures into a useful BridgeApiError', async () => {
    const client = createBridgeClient(async () => new Response('upstream unavailable', {
      status: 502,
      statusText: 'Bad Gateway',
      headers: { 'Content-Type': 'text/plain' },
    }))

    const error = await client.listProjects().catch((caught: unknown) => caught)

    expect(error).toBeInstanceOf(BridgeApiError)
    expect(error).toMatchObject({ status: 502, code: 'HTTP_ERROR' })
    expect((error as Error).message).toContain('upstream unavailable')
  })

  it('turns malformed JSON HTTP failures into a useful BridgeApiError', async () => {
    const client = createBridgeClient(async () => new Response('{broken', {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    }))

    await expect(client.listProjects()).rejects.toMatchObject({
      name: 'BridgeApiError',
      status: 500,
      code: 'HTTP_ERROR',
    })
  })

  it('rejects an empty successful response as invalid JSON', async () => {
    const client = createBridgeClient(async () => new Response(null, { status: 200 }))

    await expect(client.listProjects()).rejects.toMatchObject({
      name: 'BridgeApiError',
      status: 200,
      code: 'INVALID_RESPONSE',
    })
  })

  it('rejects a whitespace-only successful response as invalid JSON', async () => {
    const client = createBridgeClient(async () => new Response(' \r\n\t', { status: 200 }))

    await expect(client.listProjects()).rejects.toMatchObject({
      name: 'BridgeApiError',
      status: 200,
      code: 'INVALID_RESPONSE',
    })
  })

  it('rejects a null successful response for object endpoints', async () => {
    const client = createBridgeClient(async () => Response.json(null))

    await expect(client.listProjects()).rejects.toMatchObject({
      name: 'BridgeApiError',
      status: 200,
      code: 'INVALID_RESPONSE',
    })
  })
})
