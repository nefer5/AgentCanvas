import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'

const BUFFER_RETENTION_MS = 60_000

function codedError(code, message) {
  const error = new Error(message)
  error.code = code
  return error
}

function tokenMatches(actual, supplied) {
  const left = Buffer.from(String(actual ?? ''))
  const right = Buffer.from(String(supplied ?? ''))
  return left.length === right.length && timingSafeEqual(left, right)
}

function publicSession(session) {
  const { id, projectId, label, createdAt, expiresAt } = session
  return { id, projectId, label, createdAt, expiresAt }
}

export class SessionBroker {
  constructor({
    now = () => new Date(),
    randomToken = () => randomBytes(32).toString('base64url'),
  } = {}) {
    this.now = now
    this.randomToken = randomToken
    this.sessions = new Map()
  }

  register({ projectId, label, timeoutMs }) {
    if (!projectId) throw new TypeError('projectId is required')
    if (!Number.isInteger(timeoutMs) || timeoutMs < 10 || timeoutMs > 3_600_000) {
      throw new TypeError('timeoutMs is out of range')
    }

    const createdAt = this.now()
    const session = {
      id: randomUUID(),
      projectId,
      label: String(label || 'Codex').slice(0, 120),
      token: this.randomToken(),
      createdAt: createdAt.toISOString(),
      expiresAt: new Date(createdAt.getTime() + timeoutMs).toISOString(),
      decision: null,
      resolve: null,
      cleanupTimer: null,
    }
    session.timer = setTimeout(() => this.finish(session, { decision: 'timeout' }), timeoutMs)
    session.timer.unref()
    this.sessions.set(session.id, session)

    return { ...publicSession(session), token: session.token }
  }

  list(projectId) {
    return [...this.sessions.values()]
      .filter((session) => session.projectId === projectId && !session.decision)
      .map(publicSession)
  }

  has(projectId, sessionId) {
    const session = this.sessions.get(sessionId)
    return Boolean(session && session.projectId === projectId && !session.decision)
  }

  wait(sessionId, token) {
    const session = this.sessions.get(sessionId)
    if (!session) return Promise.reject(codedError('NOT_FOUND', 'Agent session not found'))
    if (!tokenMatches(session.token, token)) {
      return Promise.reject(codedError('UNAUTHORIZED', 'Invalid Agent session token'))
    }
    if (session.decision) {
      this.retire(session)
      return Promise.resolve(session.decision)
    }
    if (session.resolve) {
      return Promise.reject(codedError('ALREADY_WAITING', 'Agent session already has a waiter'))
    }

    return new Promise((resolve) => {
      session.resolve = resolve
    })
  }

  deliver(projectId, sessionId, submission) {
    const session = this.sessions.get(sessionId)
    if (!session || session.projectId !== projectId || session.decision) return false
    this.finish(session, { ...submission, decision: 'submitted' })
    return true
  }

  cancel(sessionId, token) {
    const session = this.sessions.get(sessionId)
    if (!session || session.decision) return false
    if (!tokenMatches(session.token, token)) {
      throw codedError('UNAUTHORIZED', 'Invalid Agent session token')
    }
    this.finish(session, { decision: 'dismissed' })
    return true
  }

  finish(session, decision) {
    if (session.decision) return

    clearTimeout(session.timer)
    session.decision = decision
    if (session.resolve) {
      const resolve = session.resolve
      session.resolve = null
      this.retire(session)
      resolve(decision)
      return
    }

    session.cleanupTimer = setTimeout(() => this.retire(session), BUFFER_RETENTION_MS)
    session.cleanupTimer.unref()
  }

  retire(session) {
    clearTimeout(session.cleanupTimer)
    if (this.sessions.get(session.id) === session) this.sessions.delete(session.id)
  }
}
