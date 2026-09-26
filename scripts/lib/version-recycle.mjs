// Reversible whole-directory rotation keeps large legacy version trees out of
// the active save path. No historical bytes are permanently deleted.
import { mkdir, readdir, lstat, realpath, rename, copyFile } from 'node:fs/promises'
import { join, relative, isAbsolute } from 'node:path'
import { readJsonOptional, writeJsonAtomic } from './atomic-files.mjs'

const VERSION = /^revision-([1-9][0-9]*)-[0-9a-f-]{36}\.excalidraw$/
async function safe(path, root) {
  const info = await lstat(path)
  const part = relative(await realpath(root), await realpath(path))
  if (!info.isDirectory() || info.isSymbolicLink() || part.startsWith('..') || isAbsolute(part)) throw new Error('Unsafe version directory')
}
async function journal(root) {
  const path = join(root, 'version-recycle.json')
  try { const info = await lstat(path); if (!info.isFile() || info.isSymbolicLink()) throw new Error('Unsafe recycle journal') } catch (error) { if (error.code === 'ENOENT') return null; throw error }
  return readJsonOptional(path)
}
export async function recoverVersionRecycle(root) {
  const job = await journal(root)
  if (!job || job.state === 'complete') return
  if (!/^[0-9a-f-]{36}$/.test(job.id) || !Array.isArray(job.keep) || job.keep.some(name => typeof name !== 'string' || name.includes('/') || name.includes('\\') || name === '.' || name === '..')) throw new Error('Invalid recycle journal')
  const versions = join(root, 'versions'); const parent = join(root, 'version-trash'); const archive = join(parent, job.id)
  await safe(parent, root)
  let archived = false
  try { await safe(archive, parent); archived = true } catch (error) { if (error.code !== 'ENOENT') throw error }
  if (!archived) { await safe(versions, root); await rename(versions, archive) }
  await mkdir(versions, { recursive: true }); await safe(versions, root)
  for (const name of job.keep) {
    const source = join(archive, name)
    const info = await lstat(source)
    if (!info.isFile() || info.isSymbolicLink()) throw new Error('Unsafe retained version')
    const target = join(versions, name)
    try { const targetInfo = await lstat(target); if (!targetInfo.isFile() || targetInfo.isSymbolicLink()) throw new Error('Unsafe restored version') } catch (error) { if (error.code !== 'ENOENT') throw error }
    await copyFile(source, target)
  }
  await writeJsonAtomic(join(root, 'version-recycle.json'), { ...job, state: 'complete' }, { createParent: false })
}
export async function previewVersions(root, keep = 50) {
  if (!Number.isInteger(keep) || keep < 10 || keep > 1000) throw new TypeError('keep must be 10-1000')
  await recoverVersionRecycle(root)
  const versions = join(root, 'versions'); await safe(versions, root)
  const names = await readdir(versions)
  const regular = []; const protectedNames = []
  let totalBytes = 0
  // Bounded metadata batches avoid a hundred thousand concurrent open handles.
  for (let start = 0; start < names.length; start += 100) {
    for (const entry of await Promise.all(names.slice(start, start + 100).map(async name => ({ name, info: await lstat(join(versions, name)) })))) {
      if (!entry.info.isFile() || entry.info.isSymbolicLink()) throw new Error('版本目录含非普通文件，已停止整理')
      totalBytes += entry.info.size
      const match = VERSION.exec(entry.name)
      if (match) regular.push({ name: entry.name, revision: Number(match[1]), bytes: entry.info.size })
      else protectedNames.push(entry.name)
    }
  }
  regular.sort((a, b) => b.revision - a.revision)
  const retained = regular.slice(0, keep).map(entry => entry.name)
  const referenced = new Set()
  const jobs = await readJsonOptional(join(root, 'jobs.json'))
  if (Array.isArray(jobs)) for (const job of jobs) referenced.add(job.sceneRevision)
  for (const area of ['inbox', 'processed']) {
    const path = join(root, area)
    let entries
    try { await safe(path, root); entries = await readdir(path, { withFileTypes: true }) } catch (error) { if (error.code === 'ENOENT') continue; throw error }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue
      const metaPath = join(path, entry.name, 'metadata.json')
      const info = await lstat(metaPath)
      if (!info.isFile() || info.isSymbolicLink()) throw new Error('Unsafe submission metadata')
      const metadata = await readJsonOptional(metaPath)
      if (metadata) referenced.add(metadata.sceneRevision)
    }
  }
  for (const entry of regular) if (referenced.has(entry.revision) && !retained.includes(entry.name)) retained.push(entry.name)
  const current = await readJsonOptional(join(root, 'current', 'metadata.json'))
  const pointer = current?.scenePath?.replace(/^versions\//, '')
  if (pointer && names.includes(pointer) && !retained.includes(pointer)) retained.push(pointer)
  retained.push(...protectedNames)
  const retainedSet = new Set(retained)
  const candidates = regular.filter(entry => !retainedSet.has(entry.name))
  return { totalVersions: names.length, totalBytes, candidateCount: candidates.length, candidateBytes: candidates.reduce((sum, entry) => sum + entry.bytes, 0), retained: retained.length, keepNames: retained, baseRevision: current?.revision ?? 0 }
}
