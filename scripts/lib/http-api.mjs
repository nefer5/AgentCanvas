import {
  SceneConflictError,
  SceneCorruptionError,
  validateSceneSaveInput,
} from './scene-store.mjs'

const MAX_JSON_BYTES = 32 * 1024 * 1024
const API_ROUTES = [
  [/^\/api\/health$/, ['GET', 'HEAD']],
  [/^\/api\/projects$/, ['GET']],
  [/^\/api\/projects\/select-folder$/, ['POST']],
  [/^\/api\/projects\/register$/, ['POST']],
  [/^\/api\/projects\/relocate$/, ['POST']],
  [/^\/api\/projects\/[^/]+$/, ['PATCH']],
  [/^\/api\/projects\/[^/]+\/scene$/, ['GET', 'PUT']],
  [/^\/api\/projects\/[^/]+\/agent-sessions$/, ['GET']],
  [/^\/api\/projects\/[^/]+\/submissions$/, ['POST']],
  [/^\/api\/projects\/[^/]+\/inbox$/, ['GET']],
  [/^\/api\/projects\/[^/]+\/inbox\/claim$/, ['POST']],
  [/^\/api\/agent-sessions$/, ['POST']],
  [/^\/api\/agent-sessions\/[^/]+\/wait$/, ['GET']],
  [/^\/api\/agent-sessions\/[^/]+$/, ['DELETE']],
  [/^\/api\/submissions\/[^/]+\/complete$/, ['POST']],
]

class ApiError extends Error {
  constructor(status, code, message, { details, headers } = {}) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.code = code
    this.details = details
    this.headers = headers
  }
}

function sendJson(response, status, body, { head = false, headers = {} } = {}) {
  const serialized = JSON.stringify(body)
  response.writeHead(status, {
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(serialized),
    'Content-Type': 'application/json; charset=utf-8',
    'X-Content-Type-Options': 'nosniff',
    ...headers,
  })
  response.end(head ? undefined : serialized)
}

function readJson(request) {
  const mediaType = String(request.headers['content-type'] ?? '')
    .split(';', 1)[0]
    .trim()
    .toLowerCase()
  if (mediaType !== 'application/json') {
    throw new ApiError(
      415,
      'UNSUPPORTED_MEDIA_TYPE',
      'Content-Type must be application/json',
    )
  }
  const declaredLength = Number(request.headers['content-length'])
  if (Number.isFinite(declaredLength) && declaredLength > MAX_JSON_BYTES) {
    request.resume()
    throw new ApiError(413, 'PAYLOAD_TOO_LARGE', 'JSON body exceeds 32 MiB')
  }
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    let settled = false

    request.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_JSON_BYTES) {
        if (!settled) {
          settled = true
          reject(new ApiError(413, 'PAYLOAD_TOO_LARGE', 'JSON body exceeds 32 MiB'))
        }
        return
      }
      if (!settled) chunks.push(chunk)
    })
    request.on('end', () => {
      if (settled) return
      settled = true
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      } catch {
        reject(new ApiError(400, 'INVALID_JSON', 'Request body must contain valid JSON'))
      }
    })
    request.on('error', (error) => {
      if (settled) return
      settled = true
      reject(error)
    })
  })
}

function bearerToken(request) {
  const match = /^Bearer\s+(.+)$/i.exec(request.headers.authorization ?? '')
  return match?.[1] ?? null
}

function sendError(response, status, code, message, { headers, details } = {}) {
  const error = { code, message }
  if (details !== undefined) error.details = details
  sendJson(response, status, { error }, { headers })
}

function hasAllowedOrigin(request) {
  const origin = request.headers.origin
  if (origin === undefined) return true
  let parsed
  try {
    parsed = new URL(origin)
  } catch {
    return false
  }
  const originPort = parsed.port ? Number(parsed.port) : 80
  return parsed.protocol === 'http:'
    && parsed.origin === origin
    && (parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost')
    && originPort === request.socket.localPort
}

function allowedMethodsFor(pathname) {
  return API_ROUTES.find(([pattern]) => pattern.test(pathname))?.[1] ?? null
}

function isApiPath(pathname) {
  return pathname === '/api' || pathname.startsWith('/api/')
}

function normalizePathSeparators(pathname) {
  return pathname.replace(/\\/g, '/')
}

function decodeValidPrefix(pathname) {
  let end = pathname.lastIndexOf('%')
  while (end >= 0) {
    try {
      return decodeURIComponent(pathname.slice(0, end))
    } catch {
      end = pathname.lastIndexOf('%', end - 1)
    }
  }
  return ''
}

function classifyApiPath(pathname) {
  try {
    const decodedPathname = normalizePathSeparators(decodeURIComponent(pathname))
    return { decodedPathname, isApi: isApiPath(decodedPathname), malformed: false }
  } catch {
    const decodedPrefix = normalizePathSeparators(decodeValidPrefix(pathname))
    return { decodedPathname: null, isApi: isApiPath(decodedPrefix), malformed: true }
  }
}

function sendMappedError(response, error) {
  if (error instanceof ApiError) {
    sendError(response, error.status, error.code, error.message, {
      details: error.details,
      headers: error.headers,
    })
    return
  }
  if (error instanceof SceneConflictError) {
    sendError(response, 409, 'SCENE_CONFLICT', error.message, {
      details: {
        currentRevision: error.currentRevision,
        recoveryPath: error.recoveryPath,
      },
    })
    return
  }
  if (error instanceof SceneCorruptionError) {
    sendError(response, 500, 'SCENE_CORRUPT', error.message)
    return
  }
  if (error?.code === 'PROJECT_NOT_FOUND') {
    sendError(response, 404, 'PROJECT_NOT_FOUND', error.message)
    return
  }
  if (error?.code === 'PROJECT_UNAVAILABLE'
    || error?.code === 'PROJECT_ID_MISMATCH'
    || error?.code === 'PROJECT_RELOCATION_CONFLICT'
    || error?.code === 'PROJECT_RELOCATION_REQUIRED'
    || error?.code === 'PROJECT_ID_CONFLICT') {
    sendError(response, 409, error.code, error.message)
    return
  }
  if (error?.code === 'PROJECT_ID_INVALID') {
    sendError(response, 400, error.code, error.message)
    return
  }
  if (error?.code === 'UNAUTHORIZED') {
    sendError(response, 401, 'UNAUTHORIZED', error.message)
    return
  }
  if (error?.code === 'NOT_FOUND') {
    sendError(response, 404, 'SESSION_NOT_FOUND', error.message)
    return
  }
  if (error?.code === 'ALREADY_WAITING') {
    sendError(response, 409, 'ALREADY_WAITING', error.message)
    return
  }
  if (error instanceof TypeError) {
    sendError(response, 400, 'INVALID_REQUEST', error.message)
    return
  }
  sendError(response, 500, 'INTERNAL_ERROR', 'Internal server error')
}

async function requireProject(registry, projectId) {
  const project = await registry.get(projectId)
  if (!project) {
    const error = new Error('Project not found')
    error.code = 'PROJECT_NOT_FOUND'
    throw error
  }
  return project
}

export function createBridgeApi({
  registry,
  sceneStore,
  submissionStore,
  broker,
  selectDirectory,
}) {
  async function waitForAgentSession(request, response, sessionId, token) {
    let disconnected = false
    const disconnect = () => {
      disconnected = true
      try { broker.cancel(sessionId, token) } catch {}
    }
    request.once('aborted', disconnect)
    response.once('close', disconnect)
    try {
      const waiting = broker.wait(sessionId, token)
      if (request.aborted || response.destroyed) disconnect()
      const decision = await waiting
      if (disconnected || response.destroyed || response.writableEnded) return
      return decision
    } finally {
      request.off('aborted', disconnect)
      response.off('close', disconnect)
    }
  }

  async function handleApi(request, response, pathname) {
    const { method = 'GET' } = request
    if (!hasAllowedOrigin(request)) {
      sendError(response, 403, 'FORBIDDEN_ORIGIN', 'Origin must match this loopback listener')
      return true
    }
    const allowedMethods = allowedMethodsFor(pathname)
    if (allowedMethods && !allowedMethods.includes(method)) {
      sendError(response, 405, 'METHOD_NOT_ALLOWED', 'Method not allowed', {
        headers: { Allow: allowedMethods.join(', ') },
      })
      return true
    }

    if (pathname === '/api/health') {
      sendJson(response, 200, { ok: true }, { head: method === 'HEAD' })
      return true
    }

    if (pathname === '/api/projects/select-folder' && method === 'POST') {
      const rootPath = await selectDirectory()
      const project = rootPath === null ? null : await registry.registerDirectory(rootPath)
      sendJson(response, 200, { project })
      return true
    }

    if (pathname === '/api/projects/register' && method === 'POST') {
      const input = await readJson(request)
      const project = await registry.registerDirectory(input.rootPath)
      sendJson(response, 200, { project })
      return true
    }

    if (pathname === '/api/projects' && method === 'GET') {
      sendJson(response, 200, { projects: await registry.list() })
      return true
    }

    if (pathname === '/api/projects/relocate' && method === 'POST') {
      const input = await readJson(request)
      const project = await registry.relocate(input.projectId, input.rootPath)
      if (!project) {
        const error = new Error('Project not found')
        error.code = 'PROJECT_NOT_FOUND'
        throw error
      }
      sendJson(response, 200, { project })
      return true
    }

    const projectMatch = /^\/api\/projects\/([^/]+)$/.exec(pathname)
    if (projectMatch && method === 'PATCH') {
      const input = await readJson(request)
      const project = await registry.rename(projectMatch[1], input.name)
      if (!project) {
        const error = new Error('Project not found')
        error.code = 'PROJECT_NOT_FOUND'
        throw error
      }
      sendJson(response, 200, { project })
      return true
    }

    const sceneMatch = /^\/api\/projects\/([^/]+)\/scene$/.exec(pathname)
    if (sceneMatch) {
      if (method === 'GET') {
        const project = await requireProject(registry, sceneMatch[1])
        sendJson(response, 200, await sceneStore.load(project))
        return true
      }
      if (method === 'PUT') {
        const input = await readJson(request)
        validateSceneSaveInput(input)
        const project = await requireProject(registry, sceneMatch[1])
        sendJson(response, 200, await sceneStore.save(project, input))
        return true
      }
    }

    if (pathname === '/api/agent-sessions' && method === 'POST') {
      const input = await readJson(request)
      const project = await requireProject(registry, input.projectId)
      sendJson(response, 201, broker.register({ ...input, projectId: project.id }))
      return true
    }

    const waitMatch = /^\/api\/agent-sessions\/([^/]+)\/wait$/.exec(pathname)
    if (waitMatch && method === 'GET') {
      const token = bearerToken(request)
      if (!token) throw new ApiError(401, 'UNAUTHORIZED', 'Bearer token is required')
      const decision = await waitForAgentSession(request, response, waitMatch[1], token)
      if (decision !== undefined) sendJson(response, 200, decision)
      return true
    }

    const sessionsMatch = /^\/api\/projects\/([^/]+)\/agent-sessions$/.exec(pathname)
    if (sessionsMatch && method === 'GET') {
      const project = await requireProject(registry, sessionsMatch[1])
      sendJson(response, 200, { sessions: broker.list(project.id) })
      return true
    }

    const cancelMatch = /^\/api\/agent-sessions\/([^/]+)$/.exec(pathname)
    if (cancelMatch && method === 'DELETE') {
      const token = bearerToken(request)
      if (!token) throw new ApiError(401, 'UNAUTHORIZED', 'Bearer token is required')
      if (!broker.cancel(cancelMatch[1], token)) {
        throw new ApiError(404, 'SESSION_NOT_FOUND', 'Agent session not found')
      }
      sendJson(response, 200, { decision: 'dismissed' })
      return true
    }

    const submissionMatch = /^\/api\/projects\/([^/]+)\/submissions$/.exec(pathname)
    if (submissionMatch && method === 'POST') {
      const input = await readJson(request)
      submissionStore.validateInput(input)
      const project = await requireProject(registry, submissionMatch[1])
      const receiverId = input.targetSessionId
        && broker.has(project.id, input.targetSessionId)
        ? input.targetSessionId
        : null
      const routed = await submissionStore.createForDelivery(project, input, receiverId)
      let result = routed.submission
      if (routed.shouldDeliver) {
        const delivered = broker.deliver(project.id, input.targetSessionId, result)
        if (!delivered) {
          // A session can expire after has() but before deliver(); approved recovery
          // semantics require its durable submission to become claimable immediately.
          result = await submissionStore.release(
            project,
            result.submissionId,
            receiverId,
          )
        }
      }
      sendJson(response, 201, result)
      return true
    }

    const inboxMatch = /^\/api\/projects\/([^/]+)\/inbox$/.exec(pathname)
    if (inboxMatch && method === 'GET') {
      const project = await requireProject(registry, inboxMatch[1])
      sendJson(response, 200, { submissions: await submissionStore.listPending(project) })
      return true
    }

    const claimMatch = /^\/api\/projects\/([^/]+)\/inbox\/claim$/.exec(pathname)
    if (claimMatch && method === 'POST') {
      const input = await readJson(request)
      submissionStore.validateClaimInput(input)
      const project = await requireProject(registry, claimMatch[1])
      const claimed = await submissionStore.claimOldest(
        project,
        input.receiverId,
      )
      sendJson(response, 200, claimed
        ? { decision: 'submitted', ...claimed }
        : { decision: 'empty' })
      return true
    }

    const completeMatch = /^\/api\/submissions\/([^/]+)\/complete$/.exec(pathname)
    if (completeMatch && method === 'POST') {
      const input = await readJson(request)
      submissionStore.validateSubmissionId(completeMatch[1])
      const project = await requireProject(registry, input.projectId)
      sendJson(response, 200, await submissionStore.complete(project, completeMatch[1]))
      return true
    }

    sendJson(response, 404, {
      error: { code: 'NOT_FOUND', message: 'API endpoint not found' },
    })
    return true
  }

  return {
    async handle(request, response, requestUrl) {
      const classified = classifyApiPath(requestUrl.pathname)
      if (!classified.isApi) return false
      try {
        if (classified.malformed) {
          if (!hasAllowedOrigin(request)) {
            sendError(
              response,
              403,
              'FORBIDDEN_ORIGIN',
              'Origin must match this loopback listener',
            )
            return true
          }
          throw new ApiError(400, 'INVALID_PATH', 'API pathname is malformed')
        }
        return await handleApi(request, response, classified.decodedPathname)
      } catch (error) {
        if (response.headersSent) throw error
        sendMappedError(response, error)
        return true
      }
    },
  }
}
