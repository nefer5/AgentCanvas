import { saveBoundedSnapshot, snapshotUsage, SNAPSHOT_POLICY } from './bounded-snapshots.mjs'
import { lstat, readdir, realpath, unlink } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { readJsonOptional, writeJsonAtomic } from './atomic-files.mjs'
import { KeyedSerializer } from './keyed-serializer.mjs'
import { pathKey, tryNormalizeProjectId } from './project-validator.mjs'
import { recoverVersionRecycle, previewVersions } from './version-recycle.mjs'

const REVISION_POINTER_PATTERN = /^versions\/revision-([1-9][0-9]*)-([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.excalidraw$/

export class SceneConflictError extends Error {
  constructor(currentRevision, recoveryPath) {
    super(`Scene revision conflict: current=${currentRevision}`)
    this.name = 'SceneConflictError'
    this.currentRevision = currentRevision
    this.recoveryPath = recoveryPath
  }
}

export class SceneCorruptionError extends Error {
  constructor(message, cause) {
    super(message, cause === undefined ? undefined : { cause })
    this.name = 'SceneCorruptionError'
    this.code = 'SCENE_CORRUPT'
  }
}

export function validateScene(scene) {
  return Boolean(scene && typeof scene === 'object'
    && Array.isArray(scene.elements)
    && scene.appState && typeof scene.appState === 'object'
    && scene.files && typeof scene.files === 'object')
}

export function validateSceneSaveInput(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new TypeError('Scene save input is required')
  }
  if (!validateScene(input.scene)) throw new TypeError('Invalid Excalidraw scene')
  if (Buffer.byteLength(JSON.stringify({ revision: Number.MAX_SAFE_INTEGER, scene: input.scene }, null, 2)) > 32 * 1024 * 1024) throw new TypeError('Scene exceeds the 32 MiB storage limit')
  if (!Number.isInteger(input.baseRevision) || input.baseRevision < 0) {
    throw new TypeError('baseRevision must be a non-negative integer')
  }
  return input
}

function sceneKey(project) {
  if (typeof project?.id === 'string' && project.id.trim()) {
    const id = tryNormalizeProjectId(project.id) ?? project.id.trim().toLowerCase()
    return `id:${id}`
  }
  const canonicalPath = resolve(project.canvasDir)
  return `path:${process.platform === 'win32' ? canonicalPath.toLowerCase() : canonicalPath}`
}

function isContained(root, pathname) {
  const child = relative(root, pathname)
  return child === '' || !(child === '..' || child.startsWith(`..${sep}`) || isAbsolute(child))
}

function corrupt(message, cause) {
  return new SceneCorruptionError(message, cause)
}

async function inspectSafeDirectory(pathname, label) {
  const expected = resolve(pathname)
  let info
  let canonical
  try {
    info = await lstat(expected)
    canonical = await realpath(expected)
  } catch (error) {
    throw corrupt(`${label} is unavailable`, error)
  }
  if (!info.isDirectory() || info.isSymbolicLink() || pathKey(canonical) !== pathKey(expected)) {
    throw corrupt(`${label} is redirected or has an invalid type`)
  }
  return canonical
}

async function readSafeJson(filePath, parentPath, label, readJson, { optional = false } = {}) {
  const expected = resolve(filePath)
  let info
  try {
    info = await lstat(expected)
  } catch (error) {
    if (optional && error?.code === 'ENOENT') return { exists: false, value: null }
    throw corrupt(`${label} is unavailable`, error)
  }
  if (!info.isFile() || info.isSymbolicLink()) {
    throw corrupt(`${label} must be a regular non-link file`)
  }
  let canonical
  try {
    canonical = await realpath(expected)
  } catch (error) {
    throw corrupt(`${label} is unavailable`, error)
  }
  if (pathKey(canonical) !== pathKey(expected) || !isContained(parentPath, canonical)) {
    throw corrupt(`${label} resolves outside its managed directory`)
  }
  try {
    const value = await readJson(expected)
    if (value === null) throw corrupt(`${label} disappeared while being read`)
    return { exists: true, value }
  } catch (error) {
    if (error instanceof SceneCorruptionError) throw error
    throw corrupt(`${label} contains invalid JSON`, error)
  }
}

function validTimestamp(value) {
  return typeof value === 'string' && Number.isFinite(Date.parse(value))
}

function assertSceneDocument(scene, label) {
  if (!validateScene(scene)) throw corrupt(`${label} is not a valid Excalidraw scene`)
  return scene
}

function assertLegacyMetadata(metadata) {
  if (!Number.isInteger(metadata.revision) || metadata.revision < 0
    || (metadata.updatedAt !== null && !validTimestamp(metadata.updatedAt))
    || Object.hasOwn(metadata, 'scenePath')) {
    throw corrupt('Legacy scene metadata is invalid')
  }
}

function revisionPointer(metadata) {
  if (metadata.schemaVersion !== 2
    || !Number.isInteger(metadata.revision) || metadata.revision < 1
    || !validTimestamp(metadata.updatedAt)
    || typeof metadata.scenePath !== 'string') {
    throw corrupt('Authoritative scene metadata is invalid')
  }
  const match = REVISION_POINTER_PATTERN.exec(metadata.scenePath)
  if (!match || Number(match[1]) !== metadata.revision) {
    throw corrupt('Authoritative scene pointer does not match its revision')
  }
  return metadata.scenePath
}

async function hasCommittedRevisionHistory(versionsDir) {
  let names
  try {
    names = await readdir(versionsDir)
  } catch (error) {
    throw corrupt('Scene versions directory cannot be inspected', error)
  }
  return names.some((name) => REVISION_POINTER_PATTERN.test(`versions/${name}`))
}

export function createSceneStore({
  now = () => new Date(),
  readJson = readJsonOptional,
  writeJson = writeJsonAtomic,
  serializer = new KeyedSerializer(),
  validateProject = async (project) => project,
} = {}) {
  async function loadValidated(project) {
    await recoverVersionRecycle(project.canvasDir)
    const currentDir = await inspectSafeDirectory(
      join(project.canvasDir, 'current'),
      'Current scene directory',
    )
    const metadataState = await readSafeJson(
      join(currentDir, 'metadata.json'),
      currentDir,
      'Scene metadata',
      readJson,
      { optional: true },
    )
    if (!metadataState.exists) {
      const versionsDir = await inspectSafeDirectory(
        join(project.canvasDir, 'versions'),
        'Scene versions directory',
      )
      const hasCommittedHistory = await hasCommittedRevisionHistory(versionsDir)
        || (await readdir(currentDir)).some(name => /^scene-[ab]\.excalidraw$/.test(name))
      const mirror = await readSafeJson(
        join(currentDir, 'scene.excalidraw'),
        currentDir,
        'Legacy scene mirror',
        readJson,
        { optional: true },
      )
      if (mirror.exists || hasCommittedHistory) {
        throw corrupt('Scene metadata is missing while committed scene state exists')
      }
      return {
        scene: null,
        revision: 0,
        updatedAt: null,
      }
    }

    const metadata = metadataState.value
    if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
      throw corrupt('Scene metadata must be an object')
    }
    if (metadata.schemaVersion === 1) {
      assertLegacyMetadata(metadata)
      const mirror = await readSafeJson(
        join(currentDir, 'scene.excalidraw'),
        currentDir,
        'Legacy scene mirror',
        readJson,
        { optional: metadata.revision === 0 },
      )
      return {
        scene: mirror.exists ? assertSceneDocument(mirror.value, 'Legacy scene mirror') : null,
        revision: metadata.revision,
        updatedAt: metadata.updatedAt,
      }
    }

    if (metadata.schemaVersion === 3) {
      if (!Number.isInteger(metadata.revision) || metadata.revision < 1 || !validTimestamp(metadata.updatedAt)
        || !/^current\/scene-[ab]\.excalidraw$/.test(metadata.scenePath ?? '')) throw corrupt('Invalid bounded scene metadata')
      const committed = await readSafeJson(join(project.canvasDir, ...metadata.scenePath.split('/')), currentDir, 'Current scene slot', readJson)
      if (committed.value?.revision !== metadata.revision || !validateScene(committed.value?.scene)) throw corrupt('Current scene slot revision mismatch')
      return { scene: committed.value.scene, revision: metadata.revision, updatedAt: metadata.updatedAt }
    }
    const scenePath = revisionPointer(metadata)
    const versionsDir = await inspectSafeDirectory(
      join(project.canvasDir, 'versions'),
      'Scene versions directory',
    )
    const committed = await readSafeJson(
      join(project.canvasDir, ...scenePath.split('/')),
      versionsDir,
      'Committed scene revision',
      readJson,
    )
    return {
      scene: assertSceneDocument(committed.value, 'Committed scene revision'),
      revision: metadata.revision,
      updatedAt: metadata.updatedAt,
    }
  }

  async function load(project) {
    return serializer.run(sceneKey(project), async () => {
    const guarded = await validateProject(project)
    if (!guarded) throw new TypeError('Project validation returned no project')
    return loadValidated(guarded)
    })
  }

  async function save(project, input) {
    const { scene, baseRevision } = validateSceneSaveInput(input)
    return serializer.run(sceneKey(project), async () => {
      const guarded = await validateProject(project)
      if (!guarded) throw new TypeError('Project validation returned no project')
      const current = await loadValidated(guarded)
      if (current.revision !== baseRevision) {
        const recoveryPath = await saveBoundedSnapshot(guarded.canvasDir, scene, current.revision, now().toISOString(), 'conflict')
        throw new SceneConflictError(current.revision, recoveryPath)
      }
      if (JSON.stringify(current.scene) === JSON.stringify(scene)) return { revision: current.revision, updatedAt: current.updatedAt }

      const revision = current.revision + 1
      const updatedAt = now().toISOString()
      const previousMetadata = await readJson(join(guarded.canvasDir, 'current', 'metadata.json'))
      const nextSlot = previousMetadata?.scenePath === 'current/scene-a.excalidraw' ? 'b' : 'a'
      const scenePath = `current/scene-${nextSlot}.excalidraw`
      const committedPath = join(guarded.canvasDir, ...scenePath.split('/'))
      await writeJson(
        committedPath,
        { revision, scene },
        { createParent: false },
      )
      try {
        await writeJson(join(guarded.canvasDir, 'current', 'metadata.json'), {
          schemaVersion: 3,
          revision,
          updatedAt,
          scenePath,
        }, { createParent: false })
      } catch (error) {
        try {
          await unlink(committedPath)
        } catch (cleanupError) {
          if (cleanupError?.code !== 'ENOENT') {
            throw new AggregateError(
              [error, cleanupError],
              `Scene pointer update failed and revision cleanup failed: ${committedPath}`,
            )
          }
        }
        throw error
      }
      try {
        await writeJson(
          join(guarded.canvasDir, 'current', 'scene.excalidraw'),
          scene,
          { createParent: false },
        )
      } catch {
        // The compatibility mirror is derived; the committed pointer stays authoritative.
      }
      let historyWarning = null
      try { await saveBoundedSnapshot(guarded.canvasDir, scene, revision, updatedAt) }
      catch (error) { historyWarning = `History checkpoint failed: ${error.message}` }
      return { revision, updatedAt, ...(historyWarning ? { historyWarning } : {}) }
    })
  }

  async function versions(project, input = null) {
    return serializer.run(sceneKey(project), async () => {
      const guarded = await validateProject(project)
      if (!guarded) throw new TypeError('Project validation returned no project')
      await loadValidated(guarded)
      if (input) throw Object.assign(new Error('旧版迁移式整理已停用；新快照自动按固定上限轮换'), { status: 410, code: 'LEGACY_ROTATION_DISABLED' })
      const { keepNames, ...plan } = await previewVersions(guarded.canvasDir)
      return { ...plan, snapshots: await snapshotUsage(guarded.canvasDir), policy: SNAPSHOT_POLICY }
    })
  }
  return { load, save, versions, validateSaveInput: validateSceneSaveInput }
}
