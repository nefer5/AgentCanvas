import { randomUUID } from 'node:crypto'
import {
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
} from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import {
  readJsonOptional,
  writeFileAtomic,
  writeJsonAtomic,
} from './atomic-files.mjs'
import { normalizeProjectId } from './project-validator.mjs'
import { validateScene } from './scene-store.mjs'

const CLIENT_SUBMISSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{7,120}$/
const DEFAULT_LEASE_MS = 3_600_000
const MAX_NOTE_LENGTH = 4_000
const MAX_SVG_BYTES = 10 * 1024 * 1024
const MAX_PNG_BYTES = 20 * 1024 * 1024
const SUBMISSION_FILES = ['scene.excalidraw', 'metadata.json', 'preview.svg', 'preview.png']
const SUBMISSION_STATUSES = new Set(['pending', 'received', 'processed'])
const MANAGED_PARENTS = ['.tmp', 'inbox', 'processed', 'current']

function submissionId(now, suffix) {
  return `${now.toISOString().replace(/[-:.]/g, '')}-${suffix}`
}

function decodePng(dataUrl) {
  const match = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl)
  if (!match) throw new TypeError('pngDataUrl must be a PNG data URL')
  return Buffer.from(match[1], 'base64')
}

function assertSubmissionId(value, label = 'submissionId') {
  if (typeof value !== 'string' || !CLIENT_SUBMISSION_ID_PATTERN.test(value)) {
    throw new TypeError(`${label} is invalid`)
  }
  return value
}

function assertProjectRecord(project) {
  if (!project || typeof project !== 'object'
    || typeof project.id !== 'string' || !project.id
    || typeof project.rootPath !== 'string' || !project.rootPath
    || typeof project.canvasDir !== 'string' || !project.canvasDir) {
    throw new TypeError('Invalid ProjectRecord')
  }
  return {
    ...project,
    id: normalizeProjectId(project.id, { allowScratch: true }),
    canvasDir: resolve(project.canvasDir),
  }
}

function isContained(root, pathname) {
  const child = relative(root, pathname)
  return child === '' || !(child === '..' || child.startsWith(`..${sep}`) || isAbsolute(child))
}

function childPath(root, ...parts) {
  const pathname = resolve(root, ...parts)
  if (!isContained(root, pathname)) {
    throw new TypeError('Submission path escapes project.canvasDir')
  }
  return pathname
}

async function lstatOptional(pathname) {
  try {
    return await lstat(pathname)
  } catch (error) {
    if (error?.code === 'ENOENT') return null
    throw error
  }
}

async function assertCanonicalPath(project, pathname, label) {
  const canonical = await realpath(pathname)
  if (!isContained(project.canvasDir, canonical)) {
    throw new TypeError(`${label} resolves outside project.canvasDir`)
  }
  return canonical
}

async function canonicalProject(projectRecord) {
  const project = assertProjectRecord(projectRecord)
  const info = await lstatOptional(project.canvasDir)
  if (!info || !info.isDirectory() || info.isSymbolicLink()) {
    throw new TypeError('project.canvasDir must be a real directory, not a symlink or junction')
  }
  const canvasDir = await realpath(project.canvasDir)
  return { ...project, canvasDir }
}

async function validateManagedParent(project, name, { allowFile = false, required = false } = {}) {
  const pathname = childPath(project.canvasDir, name)
  const info = await lstatOptional(pathname)
  if (!info) {
    if (required) throw new TypeError(`Managed parent ${name} is required`)
    return null
  }
  if (info.isSymbolicLink()) {
    throw new TypeError(`Managed parent ${name} must not be a symlink or junction`)
  }
  if (!info.isDirectory() && !(allowFile && info.isFile())) {
    throw new TypeError(`Managed parent ${name} has an invalid type`)
  }
  await assertCanonicalPath(project, pathname, `Managed parent ${name}`)
  return { info, pathname }
}

async function validateManagedParents(project, { requireCurrent = false } = {}) {
  await Promise.all(MANAGED_PARENTS.map((name) => validateManagedParent(
    project,
    name,
    {
      allowFile: name === 'current',
      required: name === 'inbox' || name === 'processed' || (name === 'current' && requireCurrent),
    },
  )))
}

async function ensureManagedParent(project, name, { allowFile = false } = {}) {
  const existing = await validateManagedParent(project, name, { allowFile })
  if (existing) return existing
  const pathname = childPath(project.canvasDir, name)
  await mkdir(pathname)
  return validateManagedParent(project, name, { allowFile })
}

function snapshotPaths(project, area, id) {
  const directory = childPath(project.canvasDir, area, id)
  return {
    directory,
    scenePath: childPath(directory, 'scene.excalidraw'),
    metadataPath: childPath(directory, 'metadata.json'),
    svgPath: childPath(directory, 'preview.svg'),
    pngPath: childPath(directory, 'preview.png'),
  }
}

async function validateSubmissionPath(project, area, id) {
  const paths = snapshotPaths(project, area, id)
  const info = await lstatOptional(paths.directory)
  if (!info) return null
  if (info.isSymbolicLink()) {
    throw new TypeError(`Submission path ${area}/${id} must not be a symlink or junction`)
  }
  if (!info.isDirectory()) {
    throw new TypeError(`Submission path ${area}/${id} must be a directory`)
  }
  await assertCanonicalPath(project, paths.directory, `Submission path ${area}/${id}`)
  return { info, paths }
}

function resultFrom(project, area, metadata) {
  const paths = snapshotPaths(project, area, metadata.submissionId)
  return {
    submissionId: metadata.submissionId,
    projectId: project.id,
    projectRoot: project.rootPath,
    scenePath: paths.scenePath,
    svgPath: paths.svgPath,
    pngPath: paths.pngPath,
    note: metadata.note,
    status: metadata.status,
  }
}

function invalidSnapshot(id, error) {
  return new Error(`Submission ${id} is incomplete or invalid`, { cause: error })
}

function isTimestamp(value) {
  return typeof value === 'string' && Number.isFinite(Date.parse(value))
}

function hasValidStateMetadata(metadata) {
  if (metadata.status === 'pending') {
    return metadata.receivedAt === null && metadata.processedAt === null
  }
  if (!isTimestamp(metadata.receivedAt)
    || typeof metadata.receiverId !== 'string'
    || metadata.receiverId.trim() === '') return false
  if (metadata.status === 'received') return metadata.processedAt === null
  return metadata.status === 'processed' && isTimestamp(metadata.processedAt)
}

async function inspectSnapshot(project, area, id, { strict = false } = {}) {
  const paths = snapshotPaths(project, area, id)
  let submissionPath
  try {
    submissionPath = await validateSubmissionPath(project, area, id)
  } catch (error) {
    if (strict) throw invalidSnapshot(id, error)
    return null
  }
  if (!submissionPath) return null

  try {
    const fileInfo = await Promise.all(SUBMISSION_FILES.map((name) => lstat(join(paths.directory, name))))
    if (fileInfo.some((entry) => !entry.isFile() || entry.isSymbolicLink())) {
      throw new TypeError('Snapshot entries must be regular files')
    }
    await Promise.all(SUBMISSION_FILES.map((name) => assertCanonicalPath(
      project,
      join(paths.directory, name),
      `Snapshot entry ${name}`,
    )))
    const [metadata, storedScene, storedSvg, storedPng] = await Promise.all([
      readJsonOptional(paths.metadataPath),
      readJsonOptional(paths.scenePath),
      readFile(paths.svgPath),
      readFile(paths.pngPath),
    ])
    const metadataProjectId = normalizeProjectId(metadata?.projectId, { allowScratch: true })
    if (!metadata || metadata.schemaVersion !== 1
      || metadata.submissionId !== id
      || metadataProjectId !== project.id
      || !SUBMISSION_STATUSES.has(metadata.status)
      || !Number.isInteger(metadata.sceneRevision) || metadata.sceneRevision < 0
      || typeof metadata.note !== 'string' || metadata.note.length > MAX_NOTE_LENGTH
      || !isTimestamp(metadata.createdAt)
      || (metadata.targetSessionId !== null && typeof metadata.targetSessionId !== 'string')
      || !hasValidStateMetadata(metadata)
      || !validateScene(storedScene)
      || storedSvg.length === 0 || storedSvg.length > MAX_SVG_BYTES
      || storedPng.length === 0 || storedPng.length > MAX_PNG_BYTES) {
      throw new TypeError('Snapshot contents are invalid')
    }
    const canonicalMetadata = metadata.projectId === metadataProjectId
      ? metadata
      : { ...metadata, projectId: metadataProjectId }
    return {
      metadata: canonicalMetadata,
      paths,
      result: resultFrom(project, area, canonicalMetadata),
    }
  } catch (error) {
    if (strict) throw invalidSnapshot(id, error)
    return null
  }
}

async function findExistingSnapshot(project, id) {
  for (const area of ['inbox', 'processed']) {
    const snapshot = await inspectSnapshot(project, area, id, { strict: true })
    if (snapshot) return snapshot
  }
  return null
}

async function readInbox(project) {
  const inboxPath = childPath(project.canvasDir, 'inbox')
  let entries
  try {
    entries = await readdir(inboxPath, { withFileTypes: true })
  } catch (error) {
    if (error?.code === 'ENOENT') return []
    throw error
  }
  const snapshots = await Promise.all(entries
    .filter((entry) => entry.isDirectory() && CLIENT_SUBMISSION_ID_PATTERN.test(entry.name))
    .map((entry) => inspectSnapshot(project, 'inbox', entry.name)))
  return snapshots.filter(Boolean)
}

function byCreationTime(left, right) {
  return left.metadata.createdAt.localeCompare(right.metadata.createdAt)
    || left.metadata.submissionId.localeCompare(right.metadata.submissionId)
}

function assertReceiverId(receiverId) {
  if (typeof receiverId !== 'string' || receiverId.trim() === '') {
    throw new TypeError('receiverId must be a non-empty string')
  }
}

function validatePayload(payload) {
  if (!payload || typeof payload !== 'object') throw new TypeError('Submission payload is required')
  if (!validateScene(payload.scene)) throw new TypeError('Invalid Excalidraw scene')
  const note = payload.note ?? ''
  if (typeof note !== 'string' || note.length > MAX_NOTE_LENGTH) {
    throw new TypeError('note must contain at most 4000 characters')
  }
  if (typeof payload.svg !== 'string') throw new TypeError('svg must be a string')
  const svgBytes = Buffer.byteLength(payload.svg, 'utf8')
  if (svgBytes === 0) throw new TypeError('svg must not be empty')
  if (svgBytes > MAX_SVG_BYTES) {
    throw new TypeError('svg must not exceed 10 MiB')
  }
  const png = decodePng(payload.pngDataUrl)
  if (png.length === 0) throw new TypeError('pngDataUrl must not be empty')
  if (png.length > MAX_PNG_BYTES) throw new TypeError('pngDataUrl must not exceed 20 MiB decoded')
  if (!Number.isInteger(payload.sceneRevision) || payload.sceneRevision < 0) {
    throw new TypeError('sceneRevision must be a non-negative integer')
  }
  const targetSessionId = payload.targetSessionId ?? null
  if (targetSessionId !== null && typeof targetSessionId !== 'string') {
    throw new TypeError('targetSessionId must be a string or null')
  }
  return { note, png, targetSessionId }
}

export function createSubmissionStore({
  now = () => new Date(),
  randomId = randomUUID,
  validateProject = canonicalProject,
} = {}) {
  let transition = Promise.resolve()
  const hasSharedProjectGuard = validateProject !== canonicalProject

  function serialize(operation) {
    const result = transition.then(operation, operation)
    transition = result.then(() => undefined, () => undefined)
    return result
  }

  function currentTime() {
    const value = now()
    if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
      throw new TypeError('now must return a valid Date')
    }
    return value
  }

  async function guardedProject(projectRecord) {
    const guarded = await validateProject(projectRecord)
    if (!guarded) throw new TypeError('Project validation returned no project')
    return canonicalProject(guarded)
  }

  async function recoverStaleInternal(project, leaseMs, recoveredAt) {
    const snapshots = await readInbox(project)
    const recovered = []
    for (const snapshot of snapshots) {
      const { metadata, paths } = snapshot
      if (metadata.status !== 'received' || typeof metadata.receivedAt !== 'string') continue
      const receivedAt = Date.parse(metadata.receivedAt)
      if (!Number.isFinite(receivedAt) || recoveredAt.getTime() - receivedAt <= leaseMs) continue
      const nextMetadata = {
        ...metadata,
        status: 'pending',
        receivedAt: null,
      }
      delete nextMetadata.receiverId
      await validateManagedParent(project, 'inbox')
      await validateSubmissionPath(project, 'inbox', metadata.submissionId)
      await writeJsonAtomic(paths.metadataPath, nextMetadata, { createParent: false })
      recovered.push(resultFrom(project, 'inbox', nextMetadata))
    }
    return recovered
  }

  async function receiveSnapshot(project, snapshot, receiverId, receivedAt) {
    if (snapshot.metadata.status !== 'pending') {
      throw new Error(`Submission ${snapshot.metadata.submissionId} is not pending`)
    }
    const metadata = {
      ...snapshot.metadata,
      status: 'received',
      receivedAt: receivedAt.toISOString(),
      receiverId,
    }
    await validateManagedParent(project, 'inbox')
    await validateSubmissionPath(project, 'inbox', snapshot.metadata.submissionId)
    await writeJsonAtomic(snapshot.paths.metadataPath, metadata, { createParent: false })
    return resultFrom(project, 'inbox', metadata)
  }

  async function createInternal(projectRecord, payload) {
    const normalized = validatePayload(payload)
    const project = await guardedProject(projectRecord)
    await validateManagedParents(project, { requireCurrent: hasSharedProjectGuard })
    const clientId = payload?.clientSubmissionId
    if (clientId !== undefined) {
      assertSubmissionId(clientId, 'clientSubmissionId')
      const existing = await findExistingSnapshot(project, clientId)
      if (existing) return existing.result
    }

    const createdAt = currentTime()
    let id = clientId
    if (id === undefined) {
      const suffix = randomId()
      if (typeof suffix !== 'string') throw new TypeError('randomId must return a string')
      id = submissionId(createdAt, suffix)
      assertSubmissionId(id)
      for (const area of ['inbox', 'processed']) {
        if (await validateSubmissionPath(project, area, id)) {
          throw new Error(`Submission ${id} already exists`)
        }
      }
    }

    const metadata = {
      schemaVersion: 1,
      submissionId: id,
      projectId: project.id,
      sceneRevision: payload.sceneRevision,
      status: 'pending',
      note: normalized.note,
      createdAt: createdAt.toISOString(),
      targetSessionId: normalized.targetSessionId,
      receivedAt: null,
      processedAt: null,
    }
    const temporary = snapshotPaths(project, '.tmp', id)
    const destination = snapshotPaths(project, 'inbox', id)
    await ensureManagedParent(project, '.tmp')
    await validateManagedParent(project, 'inbox', { required: true })
    await validateManagedParent(project, '.tmp')
    const existingTemporary = await validateSubmissionPath(project, '.tmp', id)
    if (existingTemporary) await rm(temporary.directory, { recursive: true })
    await validateManagedParent(project, '.tmp')
    await mkdir(temporary.directory)
    await validateSubmissionPath(project, '.tmp', id)

    try {
      await Promise.all([
        writeJsonAtomic(temporary.scenePath, payload.scene, { createParent: false }),
        writeJsonAtomic(temporary.metadataPath, metadata, { createParent: false }),
        writeFileAtomic(temporary.svgPath, payload.svg, { createParent: false }),
        writeFileAtomic(temporary.pngPath, normalized.png, { createParent: false }),
      ])
      await validateManagedParent(project, '.tmp')
      await validateManagedParent(project, 'inbox')
      await validateSubmissionPath(project, '.tmp', id)
      if (await validateSubmissionPath(project, 'inbox', id)) {
        throw new Error(`Submission ${id} already exists in inbox`)
      }
      await rename(temporary.directory, destination.directory)
    } catch (error) {
      try {
        await validateManagedParent(project, '.tmp')
        if (await validateSubmissionPath(project, '.tmp', id)) {
          await rm(temporary.directory, { recursive: true })
        }
      } catch {}
      if (clientId !== undefined) {
        await validateManagedParent(project, 'inbox')
        await validateManagedParent(project, 'processed')
        const existing = await findExistingSnapshot(project, id)
        if (existing) return existing.result
      }
      throw error
    }

    try {
      await validateManagedParent(project, 'current', { allowFile: true, required: true })
      await validateManagedParent(project, 'current', { allowFile: true })
      await Promise.allSettled([
        writeFileAtomic(
          childPath(project.canvasDir, 'current', 'preview.svg'),
          payload.svg,
          { createParent: false },
        ),
        writeFileAtomic(
          childPath(project.canvasDir, 'current', 'preview.png'),
          normalized.png,
          { createParent: false },
        ),
      ])
    } catch {}
    return resultFrom(project, 'inbox', metadata)
  }

  return {
    validateInput(payload) {
      validatePayload(payload)
      return payload
    },

    validateClaimInput(input) {
      assertReceiverId(input?.receiverId)
      return input
    },

    validateSubmissionId(id) {
      return assertSubmissionId(id)
    },

    async create(project, payload) {
      return serialize(() => createInternal(project, payload))
    },

    async createForDelivery(projectRecord, payload, receiverId = null) {
      if (receiverId !== null) {
        assertReceiverId(receiverId)
        if (payload?.targetSessionId !== receiverId) {
          throw new TypeError('receiverId must match targetSessionId')
        }
      }
      return serialize(async () => {
        const submission = await createInternal(projectRecord, payload)
        if (receiverId === null || submission.status !== 'pending') {
          return { submission, shouldDeliver: false }
        }

        const project = await guardedProject(projectRecord)
        await validateManagedParents(project, { requireCurrent: hasSharedProjectGuard })
        const snapshot = await inspectSnapshot(
          project,
          'inbox',
          submission.submissionId,
          { strict: true },
        )
        if (!snapshot) {
          throw new Error(`Submission ${submission.submissionId} was not found in inbox`)
        }
        if (snapshot.metadata.targetSessionId !== receiverId) {
          return { submission: snapshot.result, shouldDeliver: false }
        }
        const received = await receiveSnapshot(project, snapshot, receiverId, currentTime())
        return { submission: received, shouldDeliver: true }
      })
    },

    async listPending(projectRecord) {
      return serialize(async () => {
        const project = await guardedProject(projectRecord)
        await validateManagedParents(project, { requireCurrent: hasSharedProjectGuard })
        const listedAt = currentTime()
        await recoverStaleInternal(project, DEFAULT_LEASE_MS, listedAt)
        const snapshots = await readInbox(project)
        return snapshots
          .filter(({ metadata }) => metadata.status === 'pending')
          .sort(byCreationTime)
          .map(({ result }) => result)
      })
    },

    async claimOldest(projectRecord, receiverId) {
      assertReceiverId(receiverId)
      return serialize(async () => {
        const project = await guardedProject(projectRecord)
        await validateManagedParents(project, { requireCurrent: hasSharedProjectGuard })
        const claimedAt = currentTime()
        await recoverStaleInternal(project, DEFAULT_LEASE_MS, claimedAt)
        const snapshot = (await readInbox(project))
          .filter(({ metadata }) => metadata.status === 'pending')
          .sort(byCreationTime)[0]
        if (!snapshot) return null
        return receiveSnapshot(project, snapshot, receiverId, claimedAt)
      })
    },

    async markReceived(projectRecord, id, receiverId) {
      assertSubmissionId(id)
      assertReceiverId(receiverId)
      return serialize(async () => {
        const project = await guardedProject(projectRecord)
        await validateManagedParents(project, { requireCurrent: hasSharedProjectGuard })
        const snapshot = await inspectSnapshot(project, 'inbox', id, { strict: true })
        if (!snapshot) throw new Error(`Submission ${id} was not found in inbox`)
        return receiveSnapshot(project, snapshot, receiverId, currentTime())
      })
    },

    async release(projectRecord, id, receiverId) {
      assertSubmissionId(id)
      assertReceiverId(receiverId)
      return serialize(async () => {
        const project = await guardedProject(projectRecord)
        await validateManagedParents(project, { requireCurrent: hasSharedProjectGuard })
        const snapshot = await inspectSnapshot(project, 'inbox', id, { strict: true })
        if (!snapshot) throw new Error(`Submission ${id} was not found in inbox`)
        if (snapshot.metadata.status !== 'received'
          || snapshot.metadata.receiverId !== receiverId) {
          throw new Error(`Submission ${id} is not received by ${receiverId}`)
        }
        const metadata = {
          ...snapshot.metadata,
          status: 'pending',
          receivedAt: null,
        }
        delete metadata.receiverId
        await validateManagedParent(project, 'inbox')
        await validateSubmissionPath(project, 'inbox', id)
        await writeJsonAtomic(snapshot.paths.metadataPath, metadata, { createParent: false })
        return resultFrom(project, 'inbox', metadata)
      })
    },

    async recoverStale(projectRecord, leaseMs) {
      if (!Number.isFinite(leaseMs) || leaseMs < 0) {
        throw new TypeError('leaseMs must be a non-negative number')
      }
      return serialize(async () => {
        const project = await guardedProject(projectRecord)
        await validateManagedParents(project, { requireCurrent: hasSharedProjectGuard })
        return recoverStaleInternal(project, leaseMs, currentTime())
      })
    },

    async complete(projectRecord, id) {
      assertSubmissionId(id)
      return serialize(async () => {
        const project = await guardedProject(projectRecord)
        await validateManagedParents(project, { requireCurrent: hasSharedProjectGuard })
        const snapshot = await inspectSnapshot(project, 'inbox', id, { strict: true })
        if (!snapshot) throw new Error(`Submission ${id} was not found in inbox`)
        if (snapshot.metadata.status !== 'received') {
          throw new Error(`Submission ${id} must be received before completion`)
        }

        const destination = snapshotPaths(project, 'processed', id)
        await validateManagedParent(project, 'processed', { required: true })
        await validateManagedParent(project, 'inbox')
        await validateSubmissionPath(project, 'inbox', id)
        await validateManagedParent(project, 'processed')
        if (await validateSubmissionPath(project, 'processed', id)) {
          throw new Error(`Submission ${id} already exists in processed`)
        }
        const metadata = {
          ...snapshot.metadata,
          status: 'processed',
          processedAt: currentTime().toISOString(),
        }
        await writeJsonAtomic(snapshot.paths.metadataPath, metadata, { createParent: false })
        try {
          await validateManagedParent(project, 'inbox')
          await validateSubmissionPath(project, 'inbox', id)
          await validateManagedParent(project, 'processed')
          if (await validateSubmissionPath(project, 'processed', id)) {
            throw new Error(`Submission ${id} already exists in processed`)
          }
          await rename(snapshot.paths.directory, destination.directory)
        } catch (error) {
          try {
            await validateManagedParent(project, 'inbox')
            await validateSubmissionPath(project, 'inbox', id)
            await writeJsonAtomic(
              snapshot.paths.metadataPath,
              snapshot.metadata,
              { createParent: false },
            )
          } catch {}
          throw error
        }
        return resultFrom(project, 'processed', metadata)
      })
    },
  }
}
