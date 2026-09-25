import { execFileSync } from 'node:child_process'
import { readFile, stat } from 'node:fs/promises'
const files = execFileSync('git',['ls-files','--cached','--others','--exclude-standard','-z'],{encoding:'utf8'}).split('\0').filter(Boolean)
const failures = []
const forbidden = /(^|\/)(node_modules|dist|release|artifacts|\.tools|\.agent-canvas|\.superpowers)(\/|$)|\.(log|pem|key|pfx|p12)$|(^|\/)\.env($|\.)/
const secret = /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,}/
for (const path of new Set(files)) {
  let info
  try { info = await stat(path) } catch { continue } // tracked deletions are intentional
  if (forbidden.test(path) || path.startsWith('public/fonts/')) failures.push(path+': private/generated path')
  if (info.size > 2*1024*1024) failures.push(path+': unexpectedly large source file')
  if (info.isFile() && info.size < 2*1024*1024 && secret.test(await readFile(path,'utf8'))) failures.push(path+': possible credential')
}
if (failures.length) throw new Error(failures.join('\n'))
console.log(`Publish scope checked: ${new Set(files).size} paths (current working tree). Review history separately before first public push.`)
