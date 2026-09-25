import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { readFile } from 'node:fs/promises'
import { relative, resolve, sep } from 'node:path'
import { writeFileAtomic } from './atomic-files.mjs'

const execFileAsync = promisify(execFile)

function escapeGitIgnore(value) {
  return value.replace(/[\\*?\[\]#!]/g, '\\$&')
}

export async function ensureGitInfoExclude(projectRoot) {
  let topLevel
  let excludePath
  try {
    topLevel = (await execFileAsync('git', ['-C', projectRoot, 'rev-parse', '--show-toplevel'])).stdout.trim()
    const gitPath = (await execFileAsync('git', ['-C', projectRoot, 'rev-parse', '--git-path', 'info/exclude'])).stdout.trim()
    excludePath = resolve(projectRoot, gitPath)
  } catch {
    return false
  }
  const prefix = relative(topLevel, projectRoot)
    .split(sep)
    .filter(Boolean)
    .map(escapeGitIgnore)
    .join('/')
  const rule = `/${prefix ? `${prefix}/` : ''}.agent-canvas/`
  let current = ''
  try { current = await readFile(excludePath, 'utf8') } catch (error) { if (error.code !== 'ENOENT') throw error }
  const rules = current.split(/\r?\n/).map((line) => line.trim())
  if (rules.includes(rule)) return false
  const next = `${current}${current && !current.endsWith('\n') ? '\n' : ''}${rule}\n`
  await writeFileAtomic(excludePath, next)
  return true
}
