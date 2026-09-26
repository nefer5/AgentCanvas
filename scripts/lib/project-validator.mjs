import { lstat, realpath } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { readJsonOptional } from './atomic-files.mjs'
import { recoverVersionRecycle } from './version-recycle.mjs'

export const WORKSPACE_DIRS = ['current', 'inbox', 'processed', 'versions', 'candidates']
export const PROJECT_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export class ProjectValidationError extends Error {
  constructor(code, message, cause) {
    super(message, cause === undefined ? undefined : { cause })
    this.name = 'ProjectValidationError'
    this.code = code
  }
}

export function projectError(code, message, cause) {
  return new ProjectValidationError(code, message, cause)
}

export function normalizeProjectId(value, { allowScratch = false } = {}) {
  if (allowScratch && value === 'scratch') return value
  if (typeof value !== 'string' || !PROJECT_ID_PATTERN.test(value)) {
    throw projectError('PROJECT_ID_INVALID', 'Project ID must be a UUID')
  }
  return value.toLowerCase()
}

export function tryNormalizeProjectId(value) {
  try {
    return normalizeProjectId(value)
  } catch {
    return null
  }
}

export function pathKey(value) {
  const normalized = resolve(value)
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized
}

export function rootIdentity(info) {
  return { device: String(info.dev), inode: String(info.ino) }
}

function sameIdentity(expected, actual) {
  return !expected
    || (expected.device === actual.device && expected.inode === actual.inode)
}

function assertLegacyRootWasNotRecreated(entry, info) {
  if (entry.rootIdentity) return
  const createdAt = Date.parse(entry.createdAt)
  const birthtimeMs = Number(info.birthtimeMs)
  if (!Number.isFinite(createdAt)
    || !Number.isFinite(birthtimeMs)
    || birthtimeMs <= 0
    || birthtimeMs > createdAt) {
    throw projectError(
      'PROJECT_UNAVAILABLE',
      'Legacy project root identity cannot be safely migrated',
    )
  }
}

export async function inspectDirectory(pathname, label, {
  expectedIdentity,
  verifyLegacyEntry,
} = {}) {
  const expectedPath = resolve(pathname)
  let info
  let canonicalPath
  try {
    info = await lstat(expectedPath, { bigint: true })
    if (info.isSymbolicLink() || !info.isDirectory()) {
      throw projectError('PROJECT_UNAVAILABLE', `${label} is not a safe directory`)
    }
    canonicalPath = await realpath(expectedPath)
  } catch (error) {
    if (error instanceof ProjectValidationError) throw error
    throw projectError('PROJECT_UNAVAILABLE', `${label} is unavailable`, error)
  }
  if (pathKey(canonicalPath) !== pathKey(expectedPath)) {
    throw projectError('PROJECT_UNAVAILABLE', `${label} is redirected`)
  }
  const identity = rootIdentity(info)
  if (!sameIdentity(expectedIdentity, identity)) {
    throw projectError('PROJECT_UNAVAILABLE', `${label} was deleted and reused`)
  }
  if (verifyLegacyEntry) assertLegacyRootWasNotRecreated(verifyLegacyEntry, info)
  return { canonicalPath, identity }
}

export async function readSafeProjectDocument(
  canvasDir,
  readJson = readJsonOptional,
  { required = false } = {},
) {
  const projectPath = join(canvasDir, 'project.json')
  let info
  try {
    info = await lstat(projectPath)
  } catch (error) {
    if (error?.code === 'ENOENT' && !required) return null
    throw projectError('PROJECT_UNAVAILABLE', 'Agent Canvas project identity is unavailable', error)
  }
  if (info.isSymbolicLink() || !info.isFile()) {
    throw projectError('PROJECT_UNAVAILABLE', 'Agent Canvas project identity is redirected')
  }
  let canonicalPath
  try {
    canonicalPath = await realpath(projectPath)
  } catch (error) {
    throw projectError('PROJECT_UNAVAILABLE', 'Agent Canvas project identity is unavailable', error)
  }
  if (pathKey(canonicalPath) !== pathKey(projectPath)) {
    throw projectError('PROJECT_UNAVAILABLE', 'Agent Canvas project identity is redirected')
  }
  let document
  try {
    document = await readJson(projectPath)
  } catch (error) {
    throw projectError('PROJECT_UNAVAILABLE', 'Agent Canvas project identity is invalid', error)
  }
  if (!document || typeof document !== 'object' || Array.isArray(document)) {
    throw projectError('PROJECT_UNAVAILABLE', 'Agent Canvas project identity is invalid')
  }
  return document
}

export async function validateRegisteredProject(entry, {
  readJson = readJsonOptional,
  verifyLegacyIdentity = true,
} = {}) {
  const id = normalizeProjectId(entry?.id)
  if (!entry || typeof entry.rootPath !== 'string' || !entry.rootPath) {
    throw projectError('PROJECT_UNAVAILABLE', 'Registered project root is invalid')
  }
  const root = await inspectDirectory(entry.rootPath, 'Project root', {
    expectedIdentity: entry.rootIdentity,
    verifyLegacyEntry: verifyLegacyIdentity && !entry.rootIdentity ? entry : undefined,
  })
  const canvasDir = join(root.canonicalPath, '.agent-canvas')
  await inspectDirectory(canvasDir, 'Agent Canvas directory')
  const document = await readSafeProjectDocument(canvasDir, readJson, { required: true })
  let documentId
  try {
    documentId = normalizeProjectId(document.projectId)
  } catch (error) {
    throw projectError('PROJECT_ID_MISMATCH', `Agent Canvas project ID does not match ${id}`, error)
  }
  if (documentId !== id) {
    throw projectError('PROJECT_ID_MISMATCH', `Agent Canvas project ID does not match ${id}`)
  }
  await recoverVersionRecycle(canvasDir)
  for (const name of WORKSPACE_DIRS) {
    await inspectDirectory(join(canvasDir, name), `Agent Canvas ${name} directory`)
  }
  return {
    id,
    rootPath: root.canonicalPath,
    canvasDir,
    document,
    rootIdentity: root.identity,
  }
}
