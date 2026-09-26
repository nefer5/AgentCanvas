import { mkdir, lstat, realpath, readFile } from 'node:fs/promises'
import { join, relative, isAbsolute } from 'node:path'
import { writeJsonAtomic } from './atomic-files.mjs'

export const SNAPSHOT_POLICY = Object.freeze({
  historySlots: 20, historyBytes: 64 * 1024 * 1024, intervalMs: 60_000,
  conflictSlots: 3, conflictBytes: 64 * 1024 * 1024,
})
const lastCheckpoint = new Map()
async function directory(root, create = true) {
  const path = join(root, 'snapshots')
  if (create) await mkdir(path, { recursive: true })
  const info = await lstat(path)
  const part = relative(await realpath(root), await realpath(path))
  if (!info.isDirectory() || info.isSymbolicLink() || part.startsWith('..') || isAbsolute(part)) throw new Error('Unsafe snapshots directory')
  return path
}
async function slot(path, kind = 'history') {
  try {
    const info = await lstat(path)
    if (!info.isFile() || info.isSymbolicLink()) throw new Error('Unsafe snapshot slot')
    let document = JSON.parse(await readFile(path, 'utf8'))
    if (document === null) return null
    if (kind === 'conflict') {
      if (!Array.isArray(document.elements) || !document.appState || !document.files) throw new Error('Invalid conflict snapshot')
      document = { schemaVersion: 1, revision: 0, savedAt: new Date(info.mtimeMs).toISOString(), scene: document }
    }
    if (document.schemaVersion !== 1 || !Number.isInteger(document.revision) || !Number.isFinite(Date.parse(document.savedAt))) throw new Error('Invalid snapshot slot')
    return { path, bytes: info.size, document }
  } catch (error) { if (error.code === 'ENOENT') return null; throw error }
}

// Fixed slots replace expired recovery copies. No new file is created per save,
// no unbounded trash directory or background deletion process is involved.
export async function saveBoundedSnapshot(root, scene, revision, savedAt, kind = 'history', policy = SNAPSHOT_POLICY) {
  const timestamp = Date.parse(savedAt)
  if (kind === 'history' && lastCheckpoint.has(root) && timestamp - lastCheckpoint.get(root) < policy.intervalMs) return null
  const dir = await directory(root)
  const count = kind === 'history' ? policy.historySlots : policy.conflictSlots
  const budget = (kind === 'history' ? policy.historyBytes : policy.conflictBytes) - count * 5
  const paths = Array.from({ length: count }, (_, i) => join(dir, `${kind}-${i}.json`))
  const slots = await Promise.all(paths.map(path => slot(path, kind)))
  const occupied = slots.filter(Boolean).sort((a, b) => Date.parse(b.document.savedAt) - Date.parse(a.document.savedAt))
  if (kind === 'history' && occupied.length && timestamp - Date.parse(occupied[0].document.savedAt) < policy.intervalMs) {
    lastCheckpoint.set(root, Date.parse(occupied[0].document.savedAt))
    return null
  }
  const document = kind === 'conflict' ? scene : { schemaVersion: 1, revision, savedAt, scene }
  const bytes = Buffer.byteLength(`${JSON.stringify(document, null, 2)}\n`)
  if (bytes > budget) return null
  const path = paths[slots.findIndex(value => value === null)] ?? occupied.at(-1).path
  // Evict payloads before replacement so the byte cap is respected, including
  // interruption. Empty slot files are tiny and reused, never accumulated.
  let retainedBytes = bytes
  for (const existing of occupied) {
    if (existing.path === path) continue
    if (retainedBytes + existing.bytes <= budget) retainedBytes += existing.bytes
    else await writeJsonAtomic(existing.path, null, { createParent: false })
  }
  await writeJsonAtomic(path, document, { createParent: false })
  if (kind === 'history') lastCheckpoint.set(root, timestamp)
  return path
}

export async function snapshotUsage(root, policy = SNAPSHOT_POLICY) {
  let dir
  try { dir = await directory(root, false) } catch (error) { if (error.code === 'ENOENT') return { history: 0, conflicts: 0, bytes: 0, policy }; throw error }
  let total = 0; let history = 0; let conflicts = 0
  for (const [kind, count] of [['history', policy.historySlots], ['conflict', policy.conflictSlots]]) {
    for (let i = 0; i < count; i++) {
      const value = await slot(join(dir, `${kind}-${i}.json`), kind)
      if (value) { total += value.bytes; if (kind === 'history') history++; else conflicts++ }
    }
  }
  return { history, conflicts, bytes: total, policy }
}
