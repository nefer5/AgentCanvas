import assert from 'node:assert/strict'
import { execFile as execFileCallback, spawn } from 'node:child_process'
import { once } from 'node:events'
import { copyFile, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import {
  CLI_VERSION,
  createDefaultDependencies,
  findProject,
  formatCliHelp,
  parseCliArgs,
  runAgentCli,
} from './lib/agent-cli.mjs'
import { startServer } from './server.mjs'

const API_BASE = 'http://127.0.0.1:4173'
const execFileAsync = promisify(execFileCallback)
const START_SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'start-excalidraw.ps1')

const SWITCHING_SERVER_SOURCE = String.raw`import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { fileURLToPath } from 'node:url'

const portIndex = process.argv.indexOf('--port')
const port = Number(process.argv[portIndex + 1])
const markerPath = fileURLToPath(new URL('../legacy-started.marker', import.meta.url))
const configuredHealthPath = fileURLToPath(new URL('../first-health.json', import.meta.url))
const legacy = !existsSync(markerPath)
if (legacy) writeFileSync(markerPath, 'legacy process started')

createServer((request, response) => {
  if (request.method === 'GET' && request.url === '/api/health' && !legacy) {
    response.writeHead(200, { 'Content-Type': 'application/json' })
    response.end(JSON.stringify({ ok: true }))
    return
  }
  if (request.method === 'GET' && request.url === '/api/health'
      && legacy && existsSync(configuredHealthPath)) {
    response.writeHead(200, { 'Content-Type': 'application/json' })
    response.end(readFileSync(configuredHealthPath))
    return
  }
  response.writeHead(200, { 'Content-Type': 'text/html' })
  response.end('<!doctype html><title>Legacy Excalidraw</title>')
}).listen(port, '127.0.0.1')
`

const LEGACY_SERVER_SOURCE = String.raw`import { createServer } from 'node:http'

const portIndex = process.argv.indexOf('--port')
const port = Number(process.argv[portIndex + 1])
createServer((_request, response) => {
  response.writeHead(200, { 'Content-Type': 'text/html' })
  response.end('<!doctype html><title>Foreign legacy service</title>')
}).listen(port, '127.0.0.1')
`

function jsonResponse(body, { status = 200 } = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function createFetchSequence(responses, events = []) {
  const calls = []
  const fetch = async (url, options = {}) => {
    calls.push({ url: String(url), options })
    events.push(`fetch:${String(url)}`)
    if (responses.length === 0) throw new Error('Unexpected fetch call')
    const response = responses.shift()
    return typeof response === 'function' ? response(url, options) : response
  }
  fetch.calls = calls
  return fetch
}

async function createProjectFixture(
  t,
  projectId = '11111111-1111-4111-8111-111111111111',
) {
  const rootPath = await mkdtemp(join(tmpdir(), 'agent-canvas-cli-'))
  const canvasDir = join(rootPath, '.agent-canvas')
  const descendant = join(rootPath, 'packages', 'client')
  await mkdir(canvasDir)
  await mkdir(descendant, { recursive: true })
  await writeFile(join(canvasDir, 'project.json'), JSON.stringify({
    schemaVersion: 1,
    projectId,
    name: 'CLI Fixture',
    rootPath: 'C:\\stale\\location',
    createdAt: '2026-07-12T12:00:00.000Z',
  }))
  t.after(() => rm(rootPath, { recursive: true, force: true }))
  return { descendant, projectId, rootPath }
}

function relocatedProjectResponse(projectId, rootPath) {
  return jsonResponse({
    project: {
      id: projectId,
      name: 'CLI Fixture',
      rootPath: resolve(rootPath),
      canvasDir: join(resolve(rootPath), '.agent-canvas'),
      available: true,
      isScratch: false,
    },
  })
}

function capturedDependencies(overrides = {}) {
  const stdout = []
  const stderr = []
  return {
    stdout,
    stderr,
    dependencies: {
      cwd: process.cwd(),
      ensureServer: async () => {},
      fetch: async () => { throw new Error('Unexpected fetch call') },
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line),
      ...overrides,
    },
  }
}

async function getAvailablePort() {
  const server = createServer()
  await new Promise((resolvePromise, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolvePromise)
  })
  const { port } = server.address()
  await new Promise((resolvePromise, reject) => server.close((error) => {
    if (error) reject(error)
    else resolvePromise()
  }))
  return port
}

function processIsAlive(processId) {
  if (!Number.isInteger(processId) || processId <= 0) return false
  try {
    process.kill(processId, 0)
    return true
  } catch {
    return false
  }
}

async function waitFor(predicate, message, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs
  let cause
  while (Date.now() < deadline) {
    try {
      if (await predicate()) return
    } catch (error) {
      cause = error
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 50))
  }
  throw new Error(message, { cause })
}

async function stopProcess(processId) {
  if (!processIsAlive(processId)) return
  process.kill(processId)
  await waitFor(() => !processIsAlive(processId), `Process ${processId} did not stop`)
}

async function apiHealth(port) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/health`, {
      signal: AbortSignal.timeout(500),
    })
    if (!response.ok) return false
    return (await response.json())?.ok === true
  } catch {
    return false
  }
}

async function createLauncherFixture() {
  const rootPath = await mkdtemp(join(tmpdir(), 'agent-canvas-launcher-'))
  const scriptsPath = join(rootPath, 'scripts')
  await mkdir(scriptsPath)
  const startScript = join(scriptsPath, 'start-excalidraw.ps1')
  const serverScript = join(scriptsPath, 'server.mjs')
  const firstHealthPath = join(rootPath, 'first-health.json')
  await copyFile(START_SCRIPT, startScript)
  await writeFile(serverScript, SWITCHING_SERVER_SOURCE)
  return { firstHealthPath, rootPath, scriptsPath, serverScript, startScript }
}

function startFixtureServer(scriptPath, port) {
  return spawn(process.execPath, [scriptPath, '--port', String(port)], {
    stdio: 'ignore',
    windowsHide: true,
  })
}

function launcherArguments(startScript, port) {
  return [
    '-NoLogo',
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    startScript,
    '-NoBrowser',
    '-Repair',
    '-Port',
    String(port),
  ]
}

test('help aliases print human-readable help without starting the server', async () => {
  for (const args of [['--help'], ['-h'], ['help']]) {
    let ensured = false
    const { dependencies, stdout, stderr } = capturedDependencies({
      ensureServer: async () => { ensured = true },
    })

    assert.equal(await runAgentCli(args, dependencies), 0)
    assert.equal(ensured, false)
    assert.deepEqual(stderr, [])
    assert.equal(stdout.length, 1)
    assert.match(stdout[0], /Agent Canvas CLI/)
    assert.match(stdout[0], /wait/)
    assert.match(stdout[0], /--version/)
  }
})

test('each command exposes focused help without starting the server', async () => {
  for (const command of ['wait', 'inbox', 'complete', 'projects']) {
    for (const flag of ['--help', '-h']) {
      let ensured = false
      const { dependencies, stdout, stderr } = capturedDependencies({
        ensureServer: async () => { ensured = true },
      })

      assert.equal(await runAgentCli([command, flag], dependencies), 0)
      assert.equal(ensured, false)
      assert.deepEqual(stderr, [])
      assert.deepEqual(stdout, [formatCliHelp(command)])
      assert.match(stdout[0], new RegExp(`agent-canvas ${command}`))
    }
  }
})

test('version aliases print package version without starting the server', async () => {
  const version = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')).version
  assert.equal(CLI_VERSION, version)
  for (const args of [['--version'], ['-V']]) {
    let ensured = false
    const { dependencies, stdout, stderr } = capturedDependencies({
      ensureServer: async () => { ensured = true },
    })

    assert.equal(await runAgentCli(args, dependencies), 0)
    assert.equal(ensured, false)
    assert.deepEqual(stdout, [version])
    assert.deepEqual(stderr, [])
  }
})

test('CLI version matches the root package metadata', async () => {
  const packagePath = fileURLToPath(new URL('../package.json', import.meta.url))
  const packageDocument = JSON.parse(await readFile(packagePath, 'utf8'))

  assert.equal(packageDocument.version, CLI_VERSION)
})

test('parseCliArgs accepts only the documented command shapes and defaults', () => {
  assert.deepEqual(parseCliArgs(['wait']), {
    command: 'wait',
    project: undefined,
    label: 'Codex',
    timeoutSeconds: 600,
  })
  assert.deepEqual(
    parseCliArgs(['wait', '--timeout', '10', '--label', 'Review', '--project', 'E:\\work']),
    {
      command: 'wait',
      project: 'E:\\work',
      label: 'Review',
      timeoutSeconds: 10,
    },
  )
  assert.deepEqual(parseCliArgs(['inbox', '--project', 'E:\\work']), {
    command: 'inbox',
    project: 'E:\\work',
  })
  assert.deepEqual(parseCliArgs(['complete', 'submission-1', '--project', 'E:\\work']), {
    command: 'complete',
    project: 'E:\\work',
    submissionId: 'submission-1',
  })
  assert.deepEqual(parseCliArgs(['projects']), { command: 'projects' })
})

test('parseCliArgs rejects unknown, missing, duplicate, and out-of-range arguments', () => {
  for (const args of [
    [],
    ['unknown'],
    ['wait', '--timeout'],
    ['wait', '--timeout', 'not-a-number'],
    ['wait', '--timeout', '9'],
    ['wait', '--timeout', '3601'],
    ['wait', '--timeout', '10', '--timeout', '20'],
    ['wait', '--label', 'One', '--label', 'Two'],
    ['inbox', '--project', 'one', '--project', 'two'],
    ['inbox', '--label', 'Not allowed'],
    ['complete'],
    ['complete', 'one', 'two'],
    ['projects', '--project', 'E:\\work'],
  ]) {
    assert.throws(() => parseCliArgs(args), Error, args.join(' '))
  }
})

test('findProject walks upward from a descendant and uses the discovered root', async (t) => {
  const fixture = await createProjectFixture(t)
  const project = await findProject(fixture.descendant, { ancestors: true })

  assert.equal(project.projectId, fixture.projectId)
  assert.equal(project.rootPath, resolve(fixture.rootPath))
  assert.equal(project.projectPath, join(resolve(fixture.rootPath), '.agent-canvas', 'project.json'))
})

test('findProject normalizes an uppercase on-disk UUID', async (t) => {
  const fixture = await createProjectFixture(t, 'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA')

  const project = await findProject(fixture.descendant, { ancestors: true })

  assert.equal(project.projectId, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')
})

test('findProject rejects directories outside a registered project', async (t) => {
  const rootPath = await mkdtemp(join(tmpdir(), 'agent-canvas-cli-unregistered-'))
  t.after(() => rm(rootPath, { recursive: true, force: true }))

  await assert.rejects(findProject(rootPath), /Agent Canvas project/i)
})

test('wait ensures the server first, sends milliseconds, authenticates, and emits one JSON line', async (t) => {
  const { projectId, rootPath } = await createProjectFixture(t)
  const events = []
  const submitted = {
    decision: 'submitted',
    submissionId: 'sub-1',
    projectId,
    projectRoot: rootPath,
    scenePath: join(rootPath, '.agent-canvas', 'inbox', 'sub-1', 'scene.excalidraw'),
    svgPath: join(rootPath, '.agent-canvas', 'inbox', 'sub-1', 'preview.svg'),
    pngPath: join(rootPath, '.agent-canvas', 'inbox', 'sub-1', 'preview.png'),
    note: 'Review the flow',
    status: 'received',
  }
  const fetch = createFetchSequence([
    relocatedProjectResponse(projectId, rootPath),
    jsonResponse({
      id: 'session-1',
      projectId,
      label: 'Codex',
      createdAt: '2026-07-12T12:00:00.000Z',
      expiresAt: '2026-07-12T12:10:00.000Z',
      token: 'token-1',
    }, { status: 201 }),
    jsonResponse(submitted),
  ], events)
  const { dependencies, stdout, stderr } = capturedDependencies({
    cwd: rootPath,
    fetch,
    ensureServer: async () => { events.push('ensureServer') },
  })

  const code = await runAgentCli(
    ['wait', '--project', rootPath, '--label', 'Codex', '--timeout', '45'],
    dependencies,
  )

  assert.equal(code, 0)
  assert.deepEqual(events, [
    'ensureServer',
    `fetch:${API_BASE}/api/projects/relocate`,
    `fetch:${API_BASE}/api/agent-sessions`,
    `fetch:${API_BASE}/api/agent-sessions/session-1/wait`,
  ])
  assert.equal(fetch.calls[0].options.method, 'POST')
  assert.deepEqual(JSON.parse(fetch.calls[0].options.body), {
    projectId,
    rootPath: resolve(rootPath),
  })
  assert.equal(fetch.calls[1].options.method, 'POST')
  assert.deepEqual(JSON.parse(fetch.calls[1].options.body), {
    projectId,
    label: 'Codex',
    timeoutMs: 45_000,
  })
  assert.equal(fetch.calls[2].options.headers.Authorization, 'Bearer token-1')
  assert.equal(stdout.length, 1)
  assert.deepEqual(JSON.parse(stdout[0]), submitted)
  assert.deepEqual(stderr, [])
})

test('inbox atomically claims the oldest item and emits an empty decision', async (t) => {
  const { projectId, rootPath } = await createProjectFixture(t)
  const fetch = createFetchSequence([
    relocatedProjectResponse(projectId, rootPath),
    jsonResponse({ decision: 'empty' }),
  ])
  const { dependencies, stdout, stderr } = capturedDependencies({ cwd: rootPath, fetch })

  const code = await runAgentCli(['inbox', '--project', rootPath], dependencies)

  assert.equal(code, 0)
  assert.equal(fetch.calls[0].url, `${API_BASE}/api/projects/relocate`)
  assert.deepEqual(JSON.parse(fetch.calls[0].options.body), {
    projectId,
    rootPath: resolve(rootPath),
  })
  assert.equal(fetch.calls[1].url, `${API_BASE}/api/projects/${projectId}/inbox/claim`)
  assert.equal(fetch.calls[1].options.method, 'POST')
  assert.equal(typeof JSON.parse(fetch.calls[1].options.body).receiverId, 'string')
  assert.deepEqual(JSON.parse(stdout[0]), { decision: 'empty' })
  assert.deepEqual(stderr, [])
})

test('complete posts the discovered project ID and emits the actual submission ID', async (t) => {
  const { projectId, rootPath } = await createProjectFixture(t)
  const submissionId = '20260712T120000000Z-client-a1b2c3'
  const fetch = createFetchSequence([
    relocatedProjectResponse(projectId, rootPath),
    jsonResponse({
      submissionId,
      projectId,
      projectRoot: rootPath,
      scenePath: join(rootPath, '.agent-canvas', 'processed', submissionId, 'scene.excalidraw'),
      svgPath: join(rootPath, '.agent-canvas', 'processed', submissionId, 'preview.svg'),
      pngPath: join(rootPath, '.agent-canvas', 'processed', submissionId, 'preview.png'),
      note: '',
      status: 'processed',
    }),
  ])
  const { dependencies, stdout, stderr } = capturedDependencies({ cwd: rootPath, fetch })

  const code = await runAgentCli(
    ['complete', submissionId, '--project', rootPath],
    dependencies,
  )

  assert.equal(code, 0)
  assert.equal(
    fetch.calls[1].url,
    `${API_BASE}/api/submissions/${encodeURIComponent(submissionId)}/complete`,
  )
  assert.deepEqual(JSON.parse(fetch.calls[0].options.body), {
    projectId,
    rootPath: resolve(rootPath),
  })
  assert.deepEqual(JSON.parse(fetch.calls[1].options.body), { projectId })
  assert.deepEqual(JSON.parse(stdout[0]), { decision: 'completed', submissionId })
  assert.deepEqual(stderr, [])
})

test('projects needs no project and returns the API project array', async () => {
  const projects = [{
    id: 'scratch',
    name: '临时画板',
    rootPath: 'C:\\scratch',
    canvasDir: 'C:\\scratch',
    available: true,
    isScratch: true,
  }]
  const fetch = createFetchSequence([jsonResponse({ projects })])
  const { dependencies, stdout, stderr } = capturedDependencies({ fetch })

  const code = await runAgentCli(['projects'], dependencies)

  assert.equal(code, 0)
  assert.equal(fetch.calls[0].url, `${API_BASE}/api/projects`)
  assert.deepEqual(JSON.parse(stdout[0]), { decision: 'listed', projects })
  assert.deepEqual(stderr, [])
})

test('invalid arguments fail without ensuring the server or writing stdout', async () => {
  let ensured = false
  const { dependencies, stdout, stderr } = capturedDependencies({
    ensureServer: async () => { ensured = true },
  })

  const code = await runAgentCli(['projects', '--project', 'E:\\work'], dependencies)

  assert.equal(code, 1)
  assert.equal(ensured, false)
  assert.deepEqual(stdout, [])
  assert.equal(stderr.length, 1)
})

test('operational API errors write one diagnostic and no partial JSON', async (t) => {
  const { projectId, rootPath } = await createProjectFixture(t)
  const fetch = createFetchSequence([
    relocatedProjectResponse(projectId, rootPath),
    jsonResponse({
      error: { code: 'INTERNAL_ERROR', message: 'Inbox is unavailable' },
    }, { status: 500 }),
  ])
  const { dependencies, stdout, stderr } = capturedDependencies({ cwd: rootPath, fetch })

  const code = await runAgentCli(['inbox'], dependencies)

  assert.equal(code, 1)
  assert.deepEqual(stdout, [])
  assert.equal(stderr.length, 1)
  assert.match(stderr[0], /Inbox is unavailable/)
})

test('malformed API decisions are operational errors and never reach stdout', async (t) => {
  const { projectId, rootPath } = await createProjectFixture(t)
  const fetch = createFetchSequence([
    relocatedProjectResponse(projectId, rootPath),
    jsonResponse({ status: 'received' }),
  ])
  const { dependencies, stdout, stderr } = capturedDependencies({ cwd: rootPath, fetch })

  const code = await runAgentCli(['inbox'], dependencies)

  assert.equal(code, 1)
  assert.deepEqual(stdout, [])
  assert.equal(stderr.length, 1)
  assert.match(stderr[0], /decision/i)
})

test('CLI relocation handshake makes a moved project usable without duplicating its ID', async (t) => {
  const sandboxRoot = await mkdtemp(join(tmpdir(), 'agent-canvas-cli-relocation-'))
  const distRoot = join(sandboxRoot, 'dist')
  const dataRoot = join(sandboxRoot, 'data')
  const originalRoot = join(sandboxRoot, 'original')
  const relocatedRoot = join(sandboxRoot, 'relocated')
  await Promise.all([mkdir(distRoot), mkdir(originalRoot)])
  await writeFile(join(distRoot, 'index.html'), '<!doctype html><title>fixture</title>')
  const server = startServer({ root: distRoot, port: 0, dataRoot })
  await once(server, 'listening')
  t.after(async () => {
    await new Promise((resolvePromise) => server.close(resolvePromise))
    await rm(sandboxRoot, { recursive: true, force: true })
  })
  const original = await server.bridge.registry.registerDirectory(originalRoot)
  await rename(originalRoot, relocatedRoot)
  const isolatedBase = `http://127.0.0.1:${server.address().port}`
  const isolatedFetch = (url, options) => fetch(
    String(url).replace(API_BASE, isolatedBase),
    options,
  )
  const { dependencies, stdout, stderr } = capturedDependencies({
    cwd: relocatedRoot,
    fetch: isolatedFetch,
  })

  const code = await runAgentCli(['inbox'], dependencies)

  assert.equal(code, 0)
  assert.deepEqual(stderr, [])
  assert.deepEqual(stdout.map((line) => JSON.parse(line)), [{ decision: 'empty' }])
  const registryDocument = JSON.parse(await readFile(join(dataRoot, 'projects.json'), 'utf8'))
  assert.equal(registryDocument.projects.length, 1)
  assert.equal(registryDocument.projects[0].id, original.id)
  assert.equal(registryDocument.projects[0].rootPath, resolve(relocatedRoot))
})

test('default ensureServer probes health and launches the hidden no-browser script only if unavailable', async () => {
  const healthyExecCalls = []
  const healthy = createDefaultDependencies({
    fetch: async (url, options) => {
      assert.equal(String(url), `${API_BASE}/api/health`)
      assert.ok(options.signal)
      return jsonResponse({ ok: true })
    },
    execFile: async (...args) => { healthyExecCalls.push(args) },
  })
  await healthy.ensureServer()
  assert.deepEqual(healthyExecCalls, [])

  const execCalls = []
  let unavailableHealthChecks = 0
  const unavailable = createDefaultDependencies({
    fetch: async () => {
      unavailableHealthChecks += 1
      if (unavailableHealthChecks === 1) throw new TypeError('fetch failed')
      return jsonResponse({ ok: true })
    },
    execFile: async (...args) => {
      execCalls.push(args)
      return { stdout: 'captured launcher output', stderr: '' }
    },
  })
  await unavailable.ensureServer()

  assert.equal(execCalls.length, 1)
  assert.equal(unavailableHealthChecks, 2)
  const [executable, args, options] = execCalls[0]
  assert.equal(executable, 'powershell.exe')
  assert.equal(options.windowsHide, true)
  assert.equal(args.includes('-NoBrowser'), true)
  const scriptPath = args[args.indexOf('-File') + 1]
  assert.equal(scriptPath, join(dirname(fileURLToPath(import.meta.url)), 'start-excalidraw.ps1'))
})

test('default ensureServer rejects an SPA fallback masquerading as API health', async () => {
  const execCalls = []
  let healthChecks = 0
  const dependencies = createDefaultDependencies({
    fetch: async () => {
      healthChecks += 1
      return healthChecks === 1
        ? new Response('<!doctype html><title>Excalidraw Local</title>', {
            status: 200,
            headers: { 'Content-Type': 'text/html' },
          })
        : jsonResponse({ ok: true })
    },
    execFile: async (...args) => {
      execCalls.push(args)
      return { stdout: '', stderr: '' }
    },
  })

  await dependencies.ensureServer()

  assert.equal(execCalls.length, 1)
  assert.equal(healthChecks, 2)
})

test('default ensureServer rejects a service that remains incompatible after launch', async () => {
  let healthChecks = 0
  const dependencies = createDefaultDependencies({
    fetch: async () => {
      healthChecks += 1
      return new Response('<!doctype html><title>Still legacy</title>', {
        status: 200,
        headers: { 'Content-Type': 'text/html' },
      })
    },
    execFile: async () => ({ stdout: '', stderr: '' }),
  })

  await assert.rejects(dependencies.ensureServer(), /health|compatible|start/i)
  assert.equal(healthChecks, 2)
})

test('PowerShell explicit repair replaces a tracked legacy project server and waits for API health', {
  timeout: 25_000,
}, async (t) => {
  const fixture = await createLauncherFixture()
  const port = await getAvailablePort()
  const pidFile = join(fixture.rootPath, `.excalidraw-server-${port}.pid`)
  const legacy = startFixtureServer(fixture.serverScript, port)
  let replacementProcessId = null
  t.after(async () => {
    await stopProcess(legacy.pid)
    await stopProcess(replacementProcessId)
    await rm(fixture.rootPath, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 100,
    })
  })

  await waitFor(async () => {
    const response = await fetch(`http://127.0.0.1:${port}/`, {
      signal: AbortSignal.timeout(500),
    })
    return response.ok
  }, 'Legacy fixture did not start')
  assert.equal(await apiHealth(port), false)
  await writeFile(pidFile, String(legacy.pid))

  await assert.rejects(execFileAsync('powershell.exe', launcherArguments(fixture.startScript, port).filter(arg => arg !== '-Repair'), { windowsHide: true }), /No process was stopped|unresponsive|incompatible/)
  assert.equal(processIsAlive(legacy.pid), true)

  await execFileAsync('powershell.exe', launcherArguments(fixture.startScript, port), {
    timeout: 20_000,
    windowsHide: true,
  })

  replacementProcessId = Number((await readFile(pidFile, 'utf8')).trim())
  assert.notEqual(replacementProcessId, legacy.pid)
  assert.equal(processIsAlive(legacy.pid), false)
  assert.equal(processIsAlive(replacementProcessId), true)
  assert.equal(await apiHealth(port), true)
})

test('PowerShell launcher refuses to kill a foreign listener recorded in its PID file', {
  timeout: 15_000,
}, async (t) => {
  const fixture = await createLauncherFixture()
  const port = await getAvailablePort()
  const foreignScript = join(fixture.rootPath, 'foreign-server.mjs')
  const pidFile = join(fixture.rootPath, `.excalidraw-server-${port}.pid`)
  await writeFile(foreignScript, LEGACY_SERVER_SOURCE)
  const foreign = startFixtureServer(foreignScript, port)
  t.after(async () => {
    await stopProcess(foreign.pid)
    await rm(fixture.rootPath, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 100,
    })
  })

  await waitFor(async () => {
    const response = await fetch(`http://127.0.0.1:${port}/`, {
      signal: AbortSignal.timeout(500),
    })
    return response.ok
  }, 'Foreign fixture did not start')
  await writeFile(pidFile, String(foreign.pid))

  await assert.rejects(
    execFileAsync('powershell.exe', launcherArguments(fixture.startScript, port), {
      timeout: 10_000,
      windowsHide: true,
    }),
    (error) => {
      assert.match(`${error.message}\n${error.stderr ?? ''}`, /foreign|refus|untracked|unrelated/i)
      return true
    },
  )

  assert.equal(processIsAlive(foreign.pid), true)
  assert.equal(await apiHealth(port), false)
})

test('PowerShell launcher accepts only a top-level object with literal boolean true health', {
  timeout: 60_000,
}, async (t) => {
  for (const healthCase of [
    { name: 'rejects numeric one', body: '{"ok":1}', shouldReplace: true },
    { name: 'rejects string true', body: '{"ok":"true"}', shouldReplace: true },
    { name: 'rejects an ok array containing true', body: '{"ok":[true]}', shouldReplace: true },
    { name: 'rejects a top-level array containing a healthy-looking object', body: '[{"ok":true}]', shouldReplace: true },
    { name: 'rejects a top-level true scalar', body: 'true', shouldReplace: true },
    { name: 'rejects top-level null', body: 'null', shouldReplace: true },
    { name: 'accepts a top-level object with boolean true', body: '{"ok":true}', shouldReplace: false },
  ]) {
    await t.test(healthCase.name, { timeout: 15_000 }, async (subtest) => {
      const fixture = await createLauncherFixture()
      const port = await getAvailablePort()
      const pidFile = join(fixture.rootPath, `.excalidraw-server-${port}.pid`)
      await writeFile(fixture.firstHealthPath, healthCase.body)
      const initialServer = startFixtureServer(fixture.serverScript, port)
      let finalProcessId = null
      subtest.after(async () => {
        await stopProcess(initialServer.pid)
        await stopProcess(finalProcessId)
        await rm(fixture.rootPath, {
          recursive: true,
          force: true,
          maxRetries: 10,
          retryDelay: 100,
        })
      })

      await waitFor(async () => {
        const response = await fetch(`http://127.0.0.1:${port}/`, {
          signal: AbortSignal.timeout(500),
        })
        return response.ok
      }, `${healthCase.name} fixture did not start`)
      assert.equal(await apiHealth(port), !healthCase.shouldReplace)
      await writeFile(pidFile, String(initialServer.pid))

      await execFileAsync('powershell.exe', launcherArguments(fixture.startScript, port).filter(arg => healthCase.shouldReplace || arg !== '-Repair'), {
        timeout: 10_000,
        windowsHide: true,
      })

      finalProcessId = Number((await readFile(pidFile, 'utf8')).trim())
      if (healthCase.shouldReplace) {
        assert.notEqual(finalProcessId, initialServer.pid)
        assert.equal(processIsAlive(initialServer.pid), false)
      } else {
        assert.equal(finalProcessId, initialServer.pid)
        assert.equal(processIsAlive(initialServer.pid), true)
      }
      assert.equal(await apiHealth(port), true)
    })
  }
})
