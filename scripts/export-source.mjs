import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFile, appendFile, access } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
execFileSync('git', ['diff', '--exit-code', 'HEAD'], { cwd: root, stdio: 'inherit' })
const untracked = execFileSync('git', ['ls-files', '--others', '--exclude-standard'], { cwd: root, encoding: 'utf8' })
if (untracked.trim()) throw new Error('Commit intended source files before exporting.')
execFileSync(process.execPath, [join(root, 'scripts/check-publish.mjs')], { cwd: root, stdio: 'inherit' })
const { version } = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
const filename = `AgentCanvas-${version}-source.zip`
const path = join(root, 'release', filename)
let exists = false
try { await access(path); exists = true } catch { /* New archive. */ }
if (exists) throw new Error(`Source archive already exists: ${path}`)
execFileSync('git', ['archive', '--format=zip', `--prefix=AgentCanvas-${version}/`, `--output=${path}`, 'HEAD'], { cwd: root })
const hash = createHash('sha256').update(await readFile(path)).digest('hex')
await appendFile(join(root, 'release/SHA256SUMS.txt'), `${hash}  ${filename}\n`)
console.log(`Clean source snapshot: ${path}`)
