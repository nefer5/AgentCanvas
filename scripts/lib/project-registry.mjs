import { constants } from 'node:fs'
import { access, mkdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { ensureGitInfoExclude } from './git-exclude.mjs'
import { readJsonOptional, writeJsonAtomic } from './atomic-files.mjs'
import { KeyedSerializer } from './keyed-serializer.mjs'
import {
  ProjectValidationError,
  WORKSPACE_DIRS,
  inspectDirectory,
  normalizeProjectId,
  pathKey,
  projectError,
  readSafeProjectDocument,
  tryNormalizeProjectId,
  validateRegisteredProject,
} from './project-validator.mjs'

export { ProjectValidationError as ProjectRegistryError }

async function ensureSafeDirectory(pathname, label) {
  try {
    return await inspectDirectory(pathname, label)
  } catch (error) {
    if (error?.cause?.code !== 'ENOENT') throw error
  }
  try {
    await mkdir(pathname)
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error
  }
  return inspectDirectory(pathname, label)
}

async function initializeRegisteredCanvas(rootPath) {
  const canvasDir = join(rootPath, '.agent-canvas')
  await ensureSafeDirectory(canvasDir, 'Agent Canvas directory')
  for (const name of WORKSPACE_DIRS) {
    await ensureSafeDirectory(join(canvasDir, name), `Agent Canvas ${name} directory`)
  }
  return canvasDir
}

function toProjectRecord(entry, { available = true, isScratch = false } = {}) {
  const canvasDir = isScratch ? entry.rootPath : join(entry.rootPath, '.agent-canvas')
  return {
    id: entry.id,
    name: entry.name,
    rootPath: entry.rootPath,
    canvasDir,
    available,
    isScratch,
  }
}

function chooseDeterministicEntry(group, canonicalId) {
  return [...group].sort((left, right) => {
    const leftCanonical = left.entry.id === canonicalId ? 0 : 1
    const rightCanonical = right.entry.id === canonicalId ? 0 : 1
    return leftCanonical - rightCanonical
      || pathKey(left.entry.rootPath).localeCompare(pathKey(right.entry.rootPath))
      || left.index - right.index
  })[0]
}

export function createProjectRegistry({
  dataRoot = join(process.env.LOCALAPPDATA || homedir(), 'ExcalidrawAgentBridge'),
  excludeFromGit = ensureGitInfoExclude,
  mutationSerializer = new KeyedSerializer(),
  readJson = readJsonOptional,
  writeJson = writeJsonAtomic,
} = {}) {
  const registryPath = join(dataRoot, 'projects.json')
  const scratchRoot = join(dataRoot, 'scratch')

  async function readRawRegistry() {
    const registry = (await readJson(registryPath)) ?? { schemaVersion: 1, projects: [] }
    if (!registry || typeof registry !== 'object' || !Array.isArray(registry.projects)) {
      throw new Error('Project registry is invalid')
    }
    return registry
  }

  async function loadCanonicalRegistry() {
    const raw = await readRawRegistry()
    const groups = new Map()
    raw.projects.forEach((entry, index) => {
      if (!entry || typeof entry !== 'object'
        || typeof entry.rootPath !== 'string' || !entry.rootPath) {
        throw new Error('Project registry entry is invalid')
      }
      const id = normalizeProjectId(entry.id)
      const group = groups.get(id) ?? []
      group.push({ entry, index })
      groups.set(id, group)
    })

    const projects = []
    for (const [id, group] of groups) {
      const assessed = await Promise.all(group.map(async (candidate) => {
        try {
          const validated = await validateRegisteredProject(
            { ...candidate.entry, id },
            { readJson },
          )
          return { ...candidate, validated }
        } catch (error) {
          return { ...candidate, error }
        }
      }))
      const live = assessed.filter(({ validated }) => validated)
      const livePaths = new Set(live.map(({ validated }) => pathKey(validated.rootPath)))
      if (livePaths.size > 1) {
        throw projectError(
          'PROJECT_ID_CONFLICT',
          `Project ID ${id} has multiple live registered roots`,
        )
      }

      let selected
      let validated
      if (live.length > 0) {
        selected = chooseDeterministicEntry(live, id)
        validated = selected.validated
      } else {
        selected = chooseDeterministicEntry(assessed, id)
      }
      const entry = {
        ...selected.entry,
        id,
        ...(validated ? {
          rootPath: validated.rootPath,
          rootIdentity: validated.rootIdentity,
        } : {}),
      }
      projects.push(entry)

      if (validated) {
        const normalizedDocument = {
          ...validated.document,
          projectId: id,
          rootPath: validated.rootPath,
        }
        if (JSON.stringify(normalizedDocument) !== JSON.stringify(validated.document)) {
          await writeJson(
            join(validated.canvasDir, 'project.json'),
            normalizedDocument,
            { createParent: false },
          )
        }
      }
    }

    const registry = { ...raw, schemaVersion: 1, projects }
    if (JSON.stringify(registry) !== JSON.stringify(raw)) {
      await writeJson(registryPath, registry)
    }
    return registry
  }

  async function scratchProject() {
    await mkdir(scratchRoot, { recursive: true })
    for (const name of WORKSPACE_DIRS) {
      await ensureSafeDirectory(join(scratchRoot, name), `Scratch ${name} directory`)
    }
    const project = {
      schemaVersion: 1,
      projectId: 'scratch',
      name: '临时画板',
      rootPath: scratchRoot,
      createdAt: new Date().toISOString(),
    }
    const projectPath = join(scratchRoot, 'project.json')
    if (!(await readJson(projectPath))) await writeJson(projectPath, project)
    return toProjectRecord(
      { id: 'scratch', name: '临时画板', rootPath: scratchRoot },
      { isScratch: true },
    )
  }

  async function list() {
    const projects = await mutationSerializer.run('registry', async () => {
      const registry = await loadCanonicalRegistry()
      return Promise.all(registry.projects.map(async (entry) => {
        let available = true
        try {
          await validateRegisteredProject(entry, { readJson })
        } catch {
          available = false
        }
        return toProjectRecord(entry, { available })
      }))
    })
    return [await scratchProject(), ...projects]
  }

  async function registerDirectory(rootPath) {
    if (typeof rootPath !== 'string' || !rootPath) {
      throw new TypeError('Project root path is required')
    }
    const requestedRoot = resolve(rootPath)
    return mutationSerializer.run('registry', async () => {
      // Registered state must be known before any workspace directory can be created.
      const registry = await loadCanonicalRegistry()
      const selected = await inspectDirectory(requestedRoot, 'Project root')
      await access(selected.canonicalPath, constants.W_OK)
      const byPath = registry.projects.find((entry) => (
        pathKey(entry.rootPath) === pathKey(selected.canonicalPath)
      ))
      if (byPath) {
        const validated = await validateRegisteredProject(byPath, { readJson })
        await excludeFromGit(validated.rootPath)
        return toProjectRecord({ ...byPath, id: validated.id, rootPath: validated.rootPath })
      }

      const canvasDir = join(selected.canonicalPath, '.agent-canvas')
      let canvasExists = true
      try {
        await inspectDirectory(canvasDir, 'Agent Canvas directory')
      } catch (error) {
        if (error?.cause?.code !== 'ENOENT') throw error
        canvasExists = false
      }
      const onDisk = canvasExists
        ? await readSafeProjectDocument(canvasDir, readJson)
        : null
      const onDiskId = tryNormalizeProjectId(onDisk?.projectId)
      if (onDiskId) {
        const owner = registry.projects.find((entry) => entry.id === onDiskId)
        if (owner) {
          let ownerAvailable = false
          try {
            await validateRegisteredProject(owner, { readJson })
            ownerAvailable = true
          } catch (error) {
            if (error?.code !== 'PROJECT_UNAVAILABLE'
              && error?.code !== 'PROJECT_ID_MISMATCH') throw error
          }
          if (ownerAvailable) {
            throw projectError(
              'PROJECT_RELOCATION_CONFLICT',
              `Project ID ${onDiskId} is already live at another root`,
            )
          }
          throw projectError(
            'PROJECT_RELOCATION_REQUIRED',
            `Project ID ${onDiskId} must be relocated explicitly`,
          )
        }
      }

      const id = onDiskId ?? randomUUID().toLowerCase()
      const initializedCanvas = await initializeRegisteredCanvas(selected.canonicalPath)
      const projectDocument = {
        schemaVersion: 1,
        projectId: id,
        name: onDisk?.name ?? basename(selected.canonicalPath),
        rootPath: selected.canonicalPath,
        createdAt: onDisk?.createdAt ?? new Date().toISOString(),
      }
      await writeJson(
        join(initializedCanvas, 'project.json'),
        projectDocument,
        { createParent: false },
      )
      const entry = {
        id,
        name: projectDocument.name,
        rootPath: selected.canonicalPath,
        createdAt: projectDocument.createdAt,
        rootIdentity: selected.identity,
      }
      registry.projects.push(entry)
      await writeJson(registryPath, registry)
      await excludeFromGit(selected.canonicalPath)
      return toProjectRecord(entry)
    })
  }

  async function findValidated(id, { required = false } = {}) {
    const normalizedId = normalizeProjectId(id)
    return mutationSerializer.run('registry', async () => {
      const registry = await loadCanonicalRegistry()
      const entry = registry.projects.find((project) => project.id === normalizedId)
      if (!entry) {
        if (required) throw projectError('PROJECT_NOT_FOUND', 'Project not found')
        return null
      }
      const validated = await validateRegisteredProject(entry, { readJson })
      return toProjectRecord({ ...entry, id: validated.id, rootPath: validated.rootPath })
    })
  }

  async function get(id) {
    if (id === 'scratch') return scratchProject()
    try {
      normalizeProjectId(id)
    } catch {
      return null
    }
    return findValidated(id)
  }

  async function validate(id) {
    if (id === 'scratch') return scratchProject()
    return findValidated(id, { required: true })
  }

  async function renameProject(id, name) {
    const normalizedId = normalizeProjectId(id)
    if (typeof name !== 'string') throw new TypeError('Project name must be a string')
    const normalizedName = name.trim()
    if (!normalizedName || normalizedName.length > 120) {
      throw new TypeError('Project name must contain 1-120 characters')
    }
    return mutationSerializer.run('registry', async () => {
      const registry = await loadCanonicalRegistry()
      const entry = registry.projects.find((project) => project.id === normalizedId)
      if (!entry) return null
      const validated = await validateRegisteredProject(entry, { readJson })
      await writeJson(join(validated.canvasDir, 'project.json'), {
        ...validated.document,
        projectId: normalizedId,
        name: normalizedName,
        rootPath: validated.rootPath,
      }, { createParent: false })
      entry.name = normalizedName
      await writeJson(registryPath, registry)
      return toProjectRecord(entry)
    })
  }

  async function relocate(id, rootPath) {
    const normalizedId = normalizeProjectId(id)
    if (typeof rootPath !== 'string' || !rootPath) {
      throw new TypeError('Relocated project root path is required')
    }
    const requestedRoot = resolve(rootPath)
    return mutationSerializer.run('registry', async () => {
      const registry = await loadCanonicalRegistry()
      const entry = registry.projects.find((project) => project.id === normalizedId)
      if (!entry) return null
      const selected = await inspectDirectory(requestedRoot, 'Relocated project root')
      const candidate = await validateRegisteredProject({
        ...entry,
        id: normalizedId,
        rootPath: selected.canonicalPath,
        rootIdentity: selected.identity,
      }, { readJson, verifyLegacyIdentity: false })

      const samePath = pathKey(entry.rootPath) === pathKey(selected.canonicalPath)
      if (samePath) {
        await validateRegisteredProject(entry, { readJson })
      } else {
        let oldStillAvailable = false
        try {
          await validateRegisteredProject(entry, { readJson })
          oldStillAvailable = true
        } catch (error) {
          if (error?.code !== 'PROJECT_UNAVAILABLE'
            && error?.code !== 'PROJECT_ID_MISMATCH') throw error
        }
        if (oldStillAvailable) {
          throw projectError(
            'PROJECT_RELOCATION_CONFLICT',
            'Registered project is still available at its original path',
          )
        }
      }
      const pathOwner = registry.projects.find((project) => (
        project.id !== normalizedId
        && pathKey(project.rootPath) === pathKey(selected.canonicalPath)
      ))
      if (pathOwner) {
        throw projectError('PROJECT_RELOCATION_CONFLICT', 'Relocation path belongs to another project')
      }

      await writeJson(join(candidate.canvasDir, 'project.json'), {
        ...candidate.document,
        projectId: normalizedId,
        name: entry.name,
        rootPath: candidate.rootPath,
      }, { createParent: false })
      entry.rootPath = candidate.rootPath
      entry.rootIdentity = candidate.rootIdentity
      await writeJson(registryPath, registry)
      await excludeFromGit(candidate.rootPath)
      return toProjectRecord(entry)
    })
  }

  return {
    list,
    get,
    validate,
    registerDirectory,
    rename: renameProject,
    relocate,
  }
}
