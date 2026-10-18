import { cp, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
import { collectNotices } from './lib/release.mjs'

const root = fileURLToPath(new URL('../', import.meta.url))
const output = resolve(process.argv[2] ?? join(root, 'release/npm'))
await mkdir(output, { recursive: true })
const stage = await mkdtemp(join(output, 'stage-'))
const source = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
const metadata = {
  name: source.name, version: source.version, private: true, type: 'module',
  description: source.description, license: source.license, engines: source.engines,
  bin: source.bin, files: ['dist/', 'scripts/', 'LICENSES/', 'docs/', 'README.md', 'LICENSE'],
}
await writeFile(join(stage, 'package.json'), JSON.stringify(metadata, null, 2) + '\n')
for (const path of ['dist', 'scripts/lib', 'scripts/agent-canvas.mjs', 'scripts/server.mjs', 'scripts/start-excalidraw.ps1', 'scripts/stop-excalidraw.ps1', 'LICENSE', 'README.md', 'docs/getting-started.md', 'docs/dsh-embedded.md', 'docs/integration.md', 'docs/development-layout.md']) {
  const target = join(stage, path)
  await mkdir(resolve(target, '..'), { recursive: true })
  await cp(join(root, path), target, { recursive: true, filter: path => !/\.test\.|[\\/]release\.mjs$/.test(path) })
}
await collectNotices(root, stage)
const npmCli = process.env.npm_execpath
if (!npmCli) throw new Error('Run via npm run pack:local -- <output-directory>')
execFileSync(process.execPath, [npmCli, 'pack', '--ignore-scripts', '--json', '--pack-destination', output], { cwd: stage, stdio: 'inherit', windowsHide: true })
