import test from 'node:test'
import assert from 'node:assert/strict'
import { cp, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const exec = promisify(execFile)
const root = fileURLToPath(new URL('..', import.meta.url))
const script = join(root, 'packaging/windows/integration.ps1')
const windows = process.platform === 'win32'

test('isolated installer integration preserves unmanaged and user-modified skills', { skip: !windows }, async () => {
  const sandbox = await mkdtemp(join(tmpdir(), 'agentcanvas-install-'))
  const installRoot = join(sandbox, 'app with spaces')
  const userHome = join(sandbox, 'user')
  await mkdir(join(installRoot, 'skills/agent-canvas'), { recursive: true })
  await cp(join(root, 'skills/agent-canvas/SKILL.md'), join(installRoot, 'skills/agent-canvas/SKILL.md'))
  const unmanaged = join(userHome, '.codex/skills/agent-canvas/SKILL.md')
  await mkdir(join(userHome, '.codex/skills/agent-canvas'), { recursive: true })
  await writeFile(unmanaged, 'UNMANAGED')
  const run = version => exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script,
    '-Action', 'Install', '-InstallRoot', installRoot, '-Version', version, '-UserHome', userHome, '-WithSkills', '-SkipPathUpdate'], { windowsHide: true })
  await run('0.1.0')
  const managed = join(userHome, '.agents/skills/agent-canvas/SKILL.md')
  assert.equal(await readFile(managed, 'utf8'), await readFile(join(installRoot, 'skills/agent-canvas/SKILL.md'), 'utf8'))
  assert.equal(await readFile(unmanaged, 'utf8'), 'UNMANAGED')
  await run('0.1.1')
  const marker = JSON.parse(await readFile(join(userHome, '.agents/skills/agent-canvas/.agent-canvas-install.json'), 'utf8').then(s => s.replace(/^\uFEFF/, '')))
  assert.equal(marker.version, '0.1.1')
  await writeFile(managed, 'USER MODIFICATION')
  await run('0.1.2')
  assert.equal(await readFile(managed, 'utf8'), 'USER MODIFICATION')
  // Kept under the OS temp directory for diagnostic recovery; no real PATH or skills touched.
})

test('preflight rejects a downgrade before altering installed files', { skip: !windows }, async () => {
  const sandbox = await mkdtemp(join(tmpdir(), 'agentcanvas-downgrade-'))
  await mkdir(join(sandbox, 'app'))
  const pkg = join(sandbox, 'app/package.json')
  await writeFile(pkg, '{"version":"9.0.0"}')
  await assert.rejects(exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script,
    '-Action', 'Preflight', '-InstallRoot', sandbox, '-Version', '0.1.0'], { windowsHide: true }), /Downgrade/)
  assert.equal(await readFile(pkg, 'utf8'), '{"version":"9.0.0"}')
})

test('preflight gives an explicit missing-Node error', { skip: !windows }, async () => {
  const sandbox = await mkdtemp(join(tmpdir(), 'agentcanvas-no-node-'))
  const powershell = join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe')
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => k.toLowerCase() !== 'path'))
  env.Path = join(process.env.SystemRoot, 'System32')
  await assert.rejects(exec(powershell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script,
    '-Action', 'Preflight', '-InstallRoot', sandbox, '-Version', '0.1.0'], { windowsHide: true, env }), /Node\.js 20\+/)
})
