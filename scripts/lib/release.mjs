import { cp, mkdir, readFile, writeFile, readdir, stat } from 'node:fs/promises'
import { join, resolve, relative, isAbsolute } from 'node:path'

export function releaseName(version) {
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`Invalid release version: ${version}`)
  return `AgentCanvas-${version}-win-x64`
}

export function assertSafeTarget(path) {
  const normalized = path.replaceAll('\\', '/')
  if (isAbsolute(path) || /^[A-Za-z]:/.test(path) || normalized.split('/').some(s => ['..', '.', '.git', '.agent-canvas', 'node_modules', 'src', '.tools', 'artifacts'].includes(s)) || /\.test\./.test(path)) {
    throw new Error(`Unsafe release target: ${path}`)
  }
  return normalized
}

const files = [
  ['dist', 'app/dist'],
  ['scripts/lib', 'app/scripts/lib'],
  ...['agent-canvas.mjs','server.mjs','start-excalidraw.ps1','stop-excalidraw.ps1'].map(n => [`scripts/${n}`, `app/scripts/${n}`]),
  ['package.json', 'app/package.json'], ['LICENSE', 'LICENSE'],
  ['skills/agent-canvas/SKILL.md', 'skills/agent-canvas/SKILL.md'],
  ...['agent-canvas.cmd','Start AgentCanvas.cmd','integration.ps1','README-install.md'].map(n => [`packaging/windows/${n}`, n]),
]
export const releaseEntries = () => files.map(([source,target]) => ({source,target:assertSafeTarget(target)}))

export async function collectNotices(projectRoot, directory) {
  const lock = JSON.parse(await readFile(join(projectRoot, 'package-lock.json'), 'utf8'))
  const lines = ['# Third-party notices', '', 'AgentCanvas is MIT licensed. Dependencies retain their own licenses.', '', '| Package | Version | License |', '| --- | --- | --- |']
  const destination = join(directory, 'LICENSES')
  await mkdir(destination, {recursive:true})
  await cp(join(projectRoot,'packaging/windows/LICENSES'), destination, {recursive:true})
  for (const [key, pkg] of Object.entries(lock.packages)) {
    if (!key || pkg.dev || !key.startsWith('node_modules/')) continue
    const name = key.split('node_modules/').at(-1)
    lines.push(`| ${name} | ${pkg.version} | ${typeof pkg.license === 'string' ? pkg.license : 'See included package notices'} |`)
    const root = join(projectRoot,key)
    let names = []
    try { names = await readdir(root) } catch { continue }
    for (const filename of names.filter(n => /^(licen[sc]e|copying|notice|ofl)([.-]|$)/i.test(n))) {
      if (!(await stat(join(root,filename))).isFile()) continue
      const safeName = `${key.replaceAll('/', '_')}_${filename}`
      await cp(join(root,filename), join(destination,safeName))
    }
  }
  // Excalidraw bundles font license files in the distribution; preserve them too.
  const fontRoot = join(projectRoot,'public/fonts')
  async function fonts(dir) {
    for (const entry of await readdir(dir,{withFileTypes:true})) {
      const path = join(dir,entry.name)
      if (entry.isDirectory()) await fonts(path)
      else if (/licen[sc]e|ofl|copying|notice/i.test(entry.name)) await cp(path,join(destination,'font_'+relative(fontRoot,path).replaceAll('\\','_').replaceAll('/','_')))
    }
  }
  await fonts(fontRoot)
  lines.push('', '## Fonts', '', 'Assistant, Cascadia, ComicShanns, Excalifont, Liberation, Lilita, Nunito, Virgil and Xiaolai are bundled by Excalidraw. See fonts/ for their copyright notices, licenses and sources.');
  await writeFile(join(destination,'THIRD-PARTY-NOTICES.md'), lines.join('\n')+'\n')
}

export async function stageRelease(projectRoot) {
  const pkg = JSON.parse(await readFile(join(projectRoot,'package.json'),'utf8'))
  const name = releaseName(pkg.version)
  const outputRoot = join(projectRoot,'release')
  const directory = join(outputRoot,name)
  await mkdir(outputRoot,{recursive:true})
  await mkdir(directory) // A version is immutable: never overwrite an existing stage.
  for (const {source,target} of releaseEntries()) {
    const destination = resolve(directory,target)
    await mkdir(resolve(destination,'..'),{recursive:true})
    await cp(join(projectRoot,source),destination,{recursive:true,errorOnExist:true,force:false,
      filter: path => !/\.test\.|[\\/]release\.mjs$/.test(path)})
  }
  await collectNotices(projectRoot,directory)
  return {name,version:pkg.version,outputRoot,directory}
}
