import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFile, writeFile, access } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { stageRelease } from './lib/release.mjs'

const root = fileURLToPath(new URL('..',import.meta.url))
const compiler = process.env.ISCC_PATH || join(root,'.tools/inno/ISCC.exe')
try { await access(compiler) } catch { throw new Error('Inno Setup compiler missing. Run scripts/bootstrap-inno.ps1 or set ISCC_PATH.') }
const plan = await stageRelease(root)
const quote = value => `'${value.replaceAll("'", "''")}'`
const zip = join(plan.outputRoot,`${plan.name}.zip`)
execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',`Compress-Archive -LiteralPath ${quote(plan.directory)} -DestinationPath ${quote(zip)}`],{windowsHide:true,stdio:'inherit'})
execFileSync(compiler,[`/DAppVersion=${plan.version}`,`/DStageDir=${plan.directory}`,`/DOutputPath=${plan.outputRoot}`,join(root,'packaging/windows/setup.iss')],{windowsHide:true,stdio:'inherit'})
const assets = [zip,join(plan.outputRoot,`${plan.name}-setup.exe`)]
const hashes = await Promise.all(assets.map(async path => `${createHash('sha256').update(await readFile(path)).digest('hex')}  ${path.split(/[\\/]/).at(-1)}`))
await writeFile(join(plan.outputRoot,'SHA256SUMS.txt'),hashes.join('\n')+'\n')
console.log(`Release ready: ${plan.outputRoot}`)
