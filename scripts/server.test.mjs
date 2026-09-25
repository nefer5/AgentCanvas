import test from 'node:test'
import assert from 'node:assert/strict'
import { once } from 'node:events'
import { mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { contentTypeFor, isSameFilePath, resolveRequestFile, startServer } from './server.mjs'

const scene = {
  type: 'excalidraw',
  version: 2,
  source: 'http://localhost',
  elements: [{ id: 'rect-1', type: 'rectangle' }],
  appState: { viewBackgroundColor: '#ffffff' },
  files: {},
}

const submissionPayload = {
  scene,
  svg: '<svg xmlns="http://www.w3.org/2000/svg"><rect width="1" height="1"/></svg>',
  pngDataUrl: 'data:image/png;base64,iVBORw0KGgo=',
  note: 'review the flow',
  sceneRevision: 1,
}

test('recognizes the same module through a directory junction', async (t) => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), 'agent-canvas-junction-'))
  const realRoot = join(temporaryRoot, 'real')
  const junctionRoot = join(temporaryRoot, 'junction')
  const realModule = join(realRoot, 'server.mjs')
  await mkdir(realRoot, { recursive: true })
  await writeFile(realModule, 'export {}')
  await symlink(realRoot, junctionRoot, 'junction')
  t.after(() => rm(temporaryRoot, { recursive: true, force: true }))

  assert.equal(isSameFilePath(realModule, join(junctionRoot, 'server.mjs')), true)
  assert.equal(isSameFilePath(realModule, join(junctionRoot, 'missing.mjs')), false)
})

async function createFixture(t) {
  const temporaryRoot = await mkdtemp(join(tmpdir(), 'agent-canvas-http-'))
  const distRoot = join(temporaryRoot, 'dist')
  const dataRoot = join(temporaryRoot, 'data')
  const projectRoot = join(temporaryRoot, 'project')
  await Promise.all([
    mkdir(distRoot, { recursive: true }),
    mkdir(projectRoot, { recursive: true }),
  ])
  await writeFile(join(distRoot, 'index.html'), '<!doctype html><title>Agent Canvas</title>')

  const server = startServer({
    root: distRoot,
    port: 0,
    dataRoot,
    selectDirectory: async () => projectRoot,
  })
  await once(server, 'listening')
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve))
    await rm(temporaryRoot, { recursive: true, force: true })
  })

  return {
    base: `http://127.0.0.1:${server.address().port}`,
    dataRoot,
    projectRoot,
    server,
  }
}

async function responseJson(response) {
  const body = await response.json()
  assert.equal(response.ok, true, JSON.stringify(body))
  return body
}

async function postJson(url, body) {
  return responseJson(await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }))
}

async function waitFor(condition, message, timeoutMs = 500) {
  const deadline = Date.now() + timeoutMs
  while (!condition()) {
    if (Date.now() >= deadline) throw new Error(message)
    await new Promise((resolve) => setImmediate(resolve))
  }
}

test('returns browser content types', () => {
  assert.equal(contentTypeFor('app.js'), 'text/javascript; charset=utf-8')
  assert.equal(contentTypeFor('font.woff2'), 'font/woff2')
})

test('rejects traversal outside dist', () => {
  assert.equal(resolveRequestFile('C:\\app\\dist', '/../secret.txt'), null)
})

test('folder picker keeps the interactive PowerShell window visible and maps cancellation', async () => {
  const { selectWindowsFolder } = await import('./lib/windows-folder-picker.mjs')
  const calls = []
  const outputs = ['C:\\workspace\\canvas\r\n', '']
  const execFileImpl = (file, args, options, callback) => {
    calls.push({ file, args, options })
    callback(null, outputs.shift(), '')
  }

  assert.equal(await selectWindowsFolder({ execFileImpl }), 'C:\\workspace\\canvas')
  assert.equal(await selectWindowsFolder({ execFileImpl }), null)
  assert.equal(calls.length, 2)
  assert.equal(calls[0].file, 'powershell.exe')
  assert.deepEqual(calls[0].args.slice(0, 3), ['-NoProfile', '-STA', '-Command'])
  assert.equal(calls[0].options.windowsHide, false)
  assert.equal(calls[0].options.encoding, 'utf8')
  assert.equal(calls[0].args[3], [
    'Add-Type -AssemblyName System.Windows.Forms',
    "Add-Type -Name NativeWindow -Namespace AgentCanvas -MemberDefinition '[System.Runtime.InteropServices.DllImport(\"user32.dll\")] public static extern System.IntPtr GetLastActivePopup(System.IntPtr hWnd); [System.Runtime.InteropServices.DllImport(\"user32.dll\")] public static extern bool SetForegroundWindow(System.IntPtr hWnd); [System.Runtime.InteropServices.DllImport(\"user32.dll\")] public static extern bool SetWindowPos(System.IntPtr hWnd, System.IntPtr hWndInsertAfter, int X, int Y, int cx, int cy, uint flags);'",
    '$owner = New-Object System.Windows.Forms.Form',
    '$owner.ShowInTaskbar = $false',
    '$owner.TopMost = $true',
    '$owner.Opacity = 0',
    '$owner.Show()',
    '$owner.Activate()',
    '$promoteTimer = New-Object System.Windows.Forms.Timer',
    '$promoteTimer.Interval = 100',
    '$promoteTimer.Add_Tick({',
    '  $popup = [AgentCanvas.NativeWindow]::GetLastActivePopup($owner.Handle)',
    '  if ($popup -ne [IntPtr]::Zero -and $popup -ne $owner.Handle) {',
    '    [void][AgentCanvas.NativeWindow]::SetWindowPos($popup, [IntPtr](-1), 0, 0, 0, 0, 0x0043)',
    '    [void][AgentCanvas.NativeWindow]::SetForegroundWindow($popup)',
    '    $promoteTimer.Stop()',
    '  }',
    '})',
    '$promoteTimer.Start()',
    '$dialog = New-Object System.Windows.Forms.FolderBrowserDialog',
    "$dialog.Description = '选择 Agent Canvas 项目目录'",
    '$dialog.ShowNewFolderButton = $true',
    'if ($dialog.ShowDialog($owner) -eq [System.Windows.Forms.DialogResult]::OK) {',
    '  [Console]::Out.Write($dialog.SelectedPath)',
    '}',
    '$promoteTimer.Stop()',
    '$promoteTimer.Dispose()',
    '$owner.Close()',
    '$owner.Dispose()',
  ].join('\n'))
})

test('serves GET and HEAD health checks and rejects other methods', async (t) => {
  const { base } = await createFixture(t)

  const getResponse = await fetch(`${base}/api/health`)
  assert.equal(getResponse.status, 200)
  assert.deepEqual(await getResponse.json(), { ok: true })

  const headResponse = await fetch(`${base}/api/health`, { method: 'HEAD' })
  assert.equal(headResponse.status, 200)
  assert.equal(await headResponse.text(), '')

  const postResponse = await fetch(`${base}/api/health`, { method: 'POST' })
  assert.equal(postResponse.status, 405)
  assert.equal(postResponse.headers.get('allow'), 'GET, HEAD')
  assert.equal((await postResponse.json()).error.code, 'METHOD_NOT_ALLOWED')
})

test('returns method errors from the API route table with accurate Allow headers', async (t) => {
  const { base } = await createFixture(t)
  for (const [path, method, allow] of [
    ['/api/projects', 'POST', 'GET'],
    ['/api/projects/select-folder', 'GET', 'POST'],
    ['/api/projects/register', 'GET', 'POST'],
    ['/api/projects/relocate', 'GET', 'POST'],
    ['/api/projects/not-a-project/scene', 'POST', 'GET, PUT'],
  ]) {
    const response = await fetch(`${base}${path}`, { method })
    assert.equal(response.status, 405)
    assert.equal(response.headers.get('allow'), allow)
    assert.equal((await response.json()).error.code, 'METHOD_NOT_ALLOWED')
  }
})

test('accepts only same-port loopback browser origins while allowing CLI requests', async (t) => {
  const { base } = await createFixture(t)
  const port = new URL(base).port

  for (const origin of [`http://127.0.0.1:${port}`, `http://localhost:${port}`]) {
    const response = await fetch(`${base}/api/health`, { headers: { Origin: origin } })
    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), { ok: true })
  }

  for (const origin of ['https://evil.example', `http://127.0.0.1:${Number(port) + 1}`]) {
    const response = await fetch(`${base}/api/health`, { headers: { Origin: origin } })
    assert.equal(response.status, 403)
    assert.equal((await response.json()).error.code, 'FORBIDDEN_ORIGIN')
  }

  assert.equal((await fetch(`${base}/api/health`)).status, 200)
})

test('refuses to bind the bridge listener beyond 127.0.0.1', async () => {
  let server
  let failure
  try {
    server = startServer({ root: '.', port: 0, host: '0.0.0.0' })
  } catch (error) {
    failure = error
  }
  if (server) {
    await once(server, 'listening')
    await new Promise((resolve) => server.close(resolve))
  }
  assert.equal(failure?.name, 'TypeError')
  assert.match(failure?.message ?? '', /127\.0\.0\.1|loopback/i)
})

test('contains rejected async API handlers and keeps the listener alive', async (t) => {
  const { base, server } = await createFixture(t)
  const originalHandle = server.bridge.api.handle
  server.bridge.api.handle = async () => {
    throw new Error('injected handler failure')
  }

  const failure = await fetch(`${base}/api/health`)
  assert.equal(failure.status, 500)
  assert.match(failure.headers.get('content-type') ?? '', /^application\/json\b/)
  assert.equal((await failure.json()).error.code, 'INTERNAL_ERROR')

  server.bridge.api.handle = originalHandle
  assert.deepEqual(
    await responseJson(await fetch(`${base}/api/health`)),
    { ok: true },
  )
})

test('keeps static application serving separate from structured API 404s', async (t) => {
  const { base } = await createFixture(t)
  for (const path of ['/', '/canvas/project-view']) {
    const response = await fetch(`${base}${path}`)
    assert.equal(response.status, 200)
    assert.match(response.headers.get('content-type') ?? '', /^text\/html\b/)
    assert.match(await response.text(), /Agent Canvas/)
  }

  for (const path of ['/api', '/api/does-not-exist']) {
    const unknownApi = await fetch(`${base}${path}`)
    assert.equal(unknownApi.status, 404)
    assert.equal((await unknownApi.json()).error.code, 'NOT_FOUND')
  }

  const staticPost = await fetch(`${base}/index.html`, { method: 'POST' })
  assert.equal(staticPost.status, 405)
  assert.equal(await staticPost.text(), 'Method Not Allowed')
})

test('classifies decoded and malformed API pathnames before static fallback', async (t) => {
  const { base } = await createFixture(t)

  for (const path of [
    '/api%2Fmissing',
    '/ap%69/missing',
    '/api%5Cmissing',
    '/ap%69%5Cmissing',
  ]) {
    const response = await fetch(`${base}${path}`)
    const text = await response.text()
    assert.equal(response.status, 404, text)
    assert.match(response.headers.get('content-type') ?? '', /^application\/json\b/)
    assert.equal(JSON.parse(text).error.code, 'NOT_FOUND')
  }

  for (const path of [
    '/api%2',
    '/ap%69/%ZZ',
    '/api%5C%ZZ',
    '/ap%69%5C%ZZ',
  ]) {
    const response = await fetch(`${base}${path}`)
    const text = await response.text()
    assert.equal(response.status, 400, text)
    assert.match(response.headers.get('content-type') ?? '', /^application\/json\b/)
    assert.equal(JSON.parse(text).error.code, 'INVALID_PATH')
  }
})

test('leaves malformed non-API pathnames on the legacy static 400 path', async (t) => {
  const { base } = await createFixture(t)

  for (const path of ['/%ZZ', '/a%ZZ']) {
    const response = await fetch(`${base}${path}`)
    const text = await response.text()
    assert.equal(response.status, 400, text)
    assert.doesNotMatch(response.headers.get('content-type') ?? '', /^application\/json\b/)
    assert.equal(text, 'Bad Request')
  }
})

test('registers a selected project and round-trips its scene', async (t) => {
  const { base, projectRoot } = await createFixture(t)

  const selected = await responseJson(await fetch(`${base}/api/projects/select-folder`, {
    method: 'POST',
  }))
  assert.equal(selected.project.rootPath, projectRoot)

  const saved = await responseJson(await fetch(`${base}/api/projects/${selected.project.id}/scene`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ scene, baseRevision: 0 }),
  }))
  assert.equal(saved.revision, 1)

  const loaded = await responseJson(await fetch(`${base}/api/projects/${selected.project.id}/scene`))
  assert.deepEqual(loaded.scene, scene)
  assert.equal(loaded.revision, 1)
})

test('registers a project from an Agent-supplied root path', async (t) => {
  const { base, projectRoot } = await createFixture(t)
  const result = await postJson(`${base}/api/projects/register`, { rootPath: projectRoot })

  assert.equal(result.project.rootPath, projectRoot)
  assert.equal(result.project.isScratch, false)
})

test('rejects an invalid-ID relocation without changing the registered pointer', async (t) => {
  const { base, dataRoot, projectRoot } = await createFixture(t)
  const selected = await responseJson(await fetch(`${base}/api/projects/select-folder`, {
    method: 'POST',
  }))
  const candidateRoot = join(dataRoot, 'invalid-relocation')
  const candidateCanvas = join(candidateRoot, '.agent-canvas')
  await Promise.all(['current', 'inbox', 'processed', 'versions', 'candidates'].map((directory) => (
    mkdir(join(candidateCanvas, directory), { recursive: true })
  )))
  await writeFile(join(candidateCanvas, 'project.json'), JSON.stringify({
    schemaVersion: 1,
    projectId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    name: 'Wrong project',
    rootPath: candidateRoot,
    createdAt: '2026-07-12T00:00:00.000Z',
  }))

  const response = await fetch(`${base}/api/projects/relocate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ projectId: selected.project.id, rootPath: candidateRoot }),
  })

  assert.equal(response.status, 409)
  assert.equal((await response.json()).error.code, 'PROJECT_ID_MISMATCH')
  const registry = JSON.parse(await readFile(join(dataRoot, 'projects.json'), 'utf8'))
  assert.equal(registry.projects.length, 1)
  assert.equal(registry.projects[0].rootPath, projectRoot)
})

test('registered-project API operations reject missing roots without recreating them', async (t) => {
  const { base } = await createFixture(t)
  const selected = await responseJson(await fetch(`${base}/api/projects/select-folder`, {
    method: 'POST',
  }))
  await rm(selected.project.canvasDir, { recursive: true, force: true })

  const response = await fetch(`${base}/api/projects/${selected.project.id}/scene`)

  assert.equal(response.status, 409)
  assert.equal((await response.json()).error.code, 'PROJECT_UNAVAILABLE')
  await assert.rejects(stat(selected.project.canvasDir), { code: 'ENOENT' })
})

test('scene writes validate request data before reporting an unavailable project', async (t) => {
  const { base } = await createFixture(t)
  const selected = await responseJson(await fetch(`${base}/api/projects/select-folder`, {
    method: 'POST',
  }))
  const sceneUrl = `${base}/api/projects/${selected.project.id}/scene`
  await rm(selected.project.canvasDir, { recursive: true, force: true })

  const malformed = await fetch(sceneUrl, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: '{',
  })
  assert.equal(malformed.status, 400)
  assert.equal((await malformed.json()).error.code, 'INVALID_JSON')

  const invalid = await fetch(sceneUrl, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ scene: { elements: [] }, baseRevision: -1 }),
  })
  assert.equal(invalid.status, 400)
  assert.equal((await invalid.json()).error.code, 'INVALID_REQUEST')
  await assert.rejects(stat(selected.project.canvasDir), { code: 'ENOENT' })
})

test('scene save revalidates after initial project lookup and never recreates versions', async (t) => {
  const { base, server } = await createFixture(t)
  const selected = await responseJson(await fetch(`${base}/api/projects/select-folder`, {
    method: 'POST',
  }))
  const versionsDir = join(selected.project.canvasDir, 'versions')
  const initiallyValidated = await server.bridge.registry.get(selected.project.id)
  await rm(versionsDir, { recursive: true, force: true })

  await assert.rejects(
    server.bridge.sceneStore.save(initiallyValidated, { scene, baseRevision: 0 }),
    { code: 'PROJECT_UNAVAILABLE' },
  )
  await assert.rejects(stat(versionsDir), { code: 'ENOENT' })
})

test('submission writes use the shared project guard and never recreate inbox', async (t) => {
  const { base, server } = await createFixture(t)
  const selected = await responseJson(await fetch(`${base}/api/projects/select-folder`, {
    method: 'POST',
  }))
  const inboxDir = join(selected.project.canvasDir, 'inbox')
  const initiallyValidated = await server.bridge.registry.get(selected.project.id)
  await rm(inboxDir, { recursive: true, force: true })

  await assert.rejects(
    server.bridge.submissionStore.create(initiallyValidated, {
      ...submissionPayload,
      targetSessionId: null,
      clientSubmissionId: '20260712T120000000Z-guarded-write',
    }),
    { code: 'PROJECT_UNAVAILABLE' },
  )
  await assert.rejects(stat(inboxDir), { code: 'ENOENT' })
})

test('normalizes uppercase UUIDs at API route and relocation boundaries', async (t) => {
  const { base } = await createFixture(t)
  const selected = await responseJson(await fetch(`${base}/api/projects/select-folder`, {
    method: 'POST',
  }))
  const uppercaseId = selected.project.id.toUpperCase()

  const loaded = await fetch(`${base}/api/projects/${uppercaseId}/scene`)
  assert.equal(loaded.status, 200)
  assert.equal((await loaded.json()).revision, 0)

  const relocated = await responseJson(await fetch(`${base}/api/projects/relocate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ projectId: uppercaseId, rootPath: selected.project.rootPath }),
  }))
  assert.equal(relocated.project.id, selected.project.id)
})

test('returns structured JSON errors for media type, syntax, and validation failures', async (t) => {
  const { base } = await createFixture(t)
  const selected = await responseJson(await fetch(`${base}/api/projects/select-folder`, {
    method: 'POST',
  }))
  const projectUrl = `${base}/api/projects/${selected.project.id}`

  const wrongMediaType = await fetch(projectUrl, {
    method: 'PATCH',
    body: JSON.stringify({ name: 'Ignored' }),
  })
  assert.equal(wrongMediaType.status, 415)
  assert.equal((await wrongMediaType.json()).error.code, 'UNSUPPORTED_MEDIA_TYPE')

  const malformed = await fetch(projectUrl, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: '{',
  })
  assert.equal(malformed.status, 400)
  assert.equal((await malformed.json()).error.code, 'INVALID_JSON')

  const invalid = await fetch(projectUrl, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ name: '   ' }),
  })
  assert.equal(invalid.status, 400)
  assert.equal((await invalid.json()).error.code, 'INVALID_REQUEST')
})

test('rejects JSON request bodies larger than 32 MiB', async (t) => {
  const { base } = await createFixture(t)
  const response = await fetch(`${base}/api/agent-sessions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: Buffer.alloc(32 * 1024 * 1024 + 1, 0x20),
  })

  assert.equal(response.status, 413)
  assert.equal((await response.json()).error.code, 'PAYLOAD_TOO_LARGE')
})

test('returns project 404s and recoverable scene conflicts as structured errors', async (t) => {
  const { base } = await createFixture(t)
  const missing = await fetch(`${base}/api/projects/not-a-project/scene`)
  assert.equal(missing.status, 404)
  assert.equal((await missing.json()).error.code, 'PROJECT_NOT_FOUND')

  const selected = await responseJson(await fetch(`${base}/api/projects/select-folder`, {
    method: 'POST',
  }))
  const sceneUrl = `${base}/api/projects/${selected.project.id}/scene`
  await responseJson(await fetch(sceneUrl, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ scene, baseRevision: 0 }),
  }))

  const submittedScene = { ...scene, elements: [{ id: 'late-edit', type: 'ellipse' }] }
  const conflict = await fetch(sceneUrl, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ scene: submittedScene, baseRevision: 0 }),
  })
  assert.equal(conflict.status, 409)
  const conflictBody = await conflict.json()
  assert.equal(conflictBody.error.code, 'SCENE_CONFLICT')
  assert.equal(conflictBody.error.details.currentRevision, 1)
  assert.deepEqual(
    JSON.parse(await readFile(conflictBody.error.details.recoveryPath, 'utf8')),
    submittedScene,
  )
})

test('lists and renames projects while session lists hide bearer tokens', async (t) => {
  const { base } = await createFixture(t)
  const selected = await responseJson(await fetch(`${base}/api/projects/select-folder`, {
    method: 'POST',
  }))
  const projectId = selected.project.id

  const listedProjects = await responseJson(await fetch(`${base}/api/projects`))
  assert.equal(listedProjects.projects.some((project) => project.id === 'scratch'), true)
  assert.equal(listedProjects.projects.some((project) => project.id === projectId), true)

  const renamed = await responseJson(await fetch(`${base}/api/projects/${projectId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Architecture Notes' }),
  }))
  assert.equal(renamed.project.name, 'Architecture Notes')

  const session = await postJson(`${base}/api/agent-sessions`, {
    projectId,
    label: 'Codex Review',
    timeoutMs: 5000,
  })
  assert.equal(typeof session.token, 'string')
  const listedSessions = await responseJson(await fetch(
    `${base}/api/projects/${projectId}/agent-sessions`,
  ))
  assert.equal(listedSessions.sessions.length, 1)
  assert.equal(listedSessions.sessions[0].id, session.id)
  assert.equal(Object.hasOwn(listedSessions.sessions[0], 'token'), false)

  const missingBearer = await fetch(`${base}/api/agent-sessions/${session.id}`, {
    method: 'DELETE',
  })
  assert.equal(missingBearer.status, 401)
  assert.equal((await missingBearer.json()).error.code, 'UNAUTHORIZED')

  const wrongBearer = await fetch(`${base}/api/agent-sessions/${session.id}`, {
    method: 'DELETE',
    headers: { Authorization: 'Bearer wrong-token' },
  })
  assert.equal(wrongBearer.status, 401)
  assert.equal((await wrongBearer.json()).error.code, 'UNAUTHORIZED')

  const waiting = fetch(`${base}/api/agent-sessions/${session.id}/wait`, {
    headers: { Authorization: `Bearer ${session.token}` },
  }).then(responseJson)
  const cancelled = await responseJson(await fetch(`${base}/api/agent-sessions/${session.id}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${session.token}` },
  }))
  assert.deepEqual(cancelled, { decision: 'dismissed' })
  assert.deepEqual(await waiting, { decision: 'dismissed' })
  assert.deepEqual(
    (await responseJson(await fetch(`${base}/api/projects/${projectId}/agent-sessions`))).sessions,
    [],
  )
})

test('requires the Agent bearer token for wait requests', async (t) => {
  const { base } = await createFixture(t)
  const selected = await responseJson(await fetch(`${base}/api/projects/select-folder`, {
    method: 'POST',
  }))
  const session = await postJson(`${base}/api/agent-sessions`, {
    projectId: selected.project.id,
    label: 'Codex',
    timeoutMs: 5000,
  })

  const missing = await fetch(`${base}/api/agent-sessions/${session.id}/wait`)
  assert.equal(missing.status, 401)
  assert.equal((await missing.json()).error.code, 'UNAUTHORIZED')

  const wrong = await fetch(`${base}/api/agent-sessions/${session.id}/wait`, {
    headers: { Authorization: 'Bearer wrong-token' },
  })
  assert.equal(wrong.status, 401)
  assert.equal((await wrong.json()).error.code, 'UNAUTHORIZED')

  await responseJson(await fetch(`${base}/api/agent-sessions/${session.id}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${session.token}` },
  }))
})

test('retires an aborted HTTP waiter before later submissions can target it', async (t) => {
  const { base, server } = await createFixture(t)
  const selected = await responseJson(await fetch(`${base}/api/projects/select-folder`, {
    method: 'POST',
  }))
  const projectId = selected.project.id
  const session = await postJson(`${base}/api/agent-sessions`, {
    projectId,
    label: 'Disconnected Codex',
    timeoutMs: 5000,
  })
  const controller = new AbortController()
  const waiting = fetch(`${base}/api/agent-sessions/${session.id}/wait`, {
    headers: { Authorization: `Bearer ${session.token}` },
    signal: controller.signal,
  })
  await waitFor(
    () => Boolean(server.bridge.broker.sessions.get(session.id)?.resolve),
    'HTTP waiter never attached to the broker session',
  )

  controller.abort()
  await assert.rejects(waiting, { name: 'AbortError' })
  await waitFor(
    () => server.bridge.broker.list(projectId).length === 0,
    'aborted HTTP waiter remained publicly routable',
  )

  const submission = await postJson(`${base}/api/projects/${projectId}/submissions`, {
    ...submissionPayload,
    targetSessionId: session.id,
    clientSubmissionId: '20260712T120000000Z-aborted-waiter',
  })
  assert.equal(submission.status, 'pending')
  const metadata = JSON.parse(await readFile(
    join(selected.project.canvasDir, 'inbox', submission.submissionId, 'metadata.json'),
    'utf8',
  ))
  assert.equal(metadata.status, 'pending')
})

test('returns structured not-found and duplicate-wait errors for Agent sessions', async (t) => {
  const { base, server } = await createFixture(t)
  const unknown = await fetch(`${base}/api/agent-sessions/missing/wait`, {
    headers: { Authorization: 'Bearer unknown-token' },
  })
  assert.equal(unknown.status, 404)
  assert.equal((await unknown.json()).error.code, 'SESSION_NOT_FOUND')

  const selected = await responseJson(await fetch(`${base}/api/projects/select-folder`, {
    method: 'POST',
  }))
  const session = await postJson(`${base}/api/agent-sessions`, {
    projectId: selected.project.id,
    label: 'Codex',
    timeoutMs: 5000,
  })
  const attachedWaiter = server.bridge.broker.wait(session.id, session.token)
  const duplicate = await fetch(`${base}/api/agent-sessions/${session.id}/wait`, {
    headers: { Authorization: `Bearer ${session.token}` },
  })
  assert.equal(duplicate.status, 409)
  assert.equal((await duplicate.json()).error.code, 'ALREADY_WAITING')

  await responseJson(await fetch(`${base}/api/agent-sessions/${session.id}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${session.token}` },
  }))
  assert.deepEqual(await attachedWaiter, { decision: 'dismissed' })
})

test('delivers online submissions and leaves offline submissions pending', async (t) => {
  const { base } = await createFixture(t)
  const selected = await responseJson(await fetch(`${base}/api/projects/select-folder`, {
    method: 'POST',
  }))
  const projectId = selected.project.id
  const session = await postJson(`${base}/api/agent-sessions`, {
    projectId,
    label: 'Codex',
    timeoutMs: 5000,
  })
  const waiting = fetch(`${base}/api/agent-sessions/${session.id}/wait`, {
    headers: { Authorization: `Bearer ${session.token}` },
  }).then(responseJson)

  const delivered = await postJson(`${base}/api/projects/${projectId}/submissions`, {
    ...submissionPayload,
    targetSessionId: session.id,
    clientSubmissionId: '20260712T120000000Z-online-test',
  })
  assert.equal(delivered.status, 'received')
  const received = await waiting
  assert.equal(received.submissionId, delivered.submissionId)
  assert.equal(received.scenePath, delivered.scenePath)
  assert.equal(received.svgPath, delivered.svgPath)
  assert.equal(received.pngPath, delivered.pngPath)

  const offline = await postJson(`${base}/api/projects/${projectId}/submissions`, {
    ...submissionPayload,
    targetSessionId: null,
    clientSubmissionId: '20260712T120000000Z-offline-test',
  })
  assert.equal(offline.status, 'pending')

  const metadata = JSON.parse(await readFile(
    join(selected.project.canvasDir, 'inbox', offline.submissionId, 'metadata.json'),
    'utf8',
  ))
  assert.equal(metadata.status, 'pending')
})

test('concurrent duplicate targeted submissions deliver once without errors or release', async (t) => {
  const { base } = await createFixture(t)
  const selected = await responseJson(await fetch(`${base}/api/projects/select-folder`, {
    method: 'POST',
  }))
  const projectId = selected.project.id
  const session = await postJson(`${base}/api/agent-sessions`, {
    projectId,
    label: 'Concurrent Codex',
    timeoutMs: 5000,
  })
  const waiting = fetch(`${base}/api/agent-sessions/${session.id}/wait`, {
    headers: { Authorization: `Bearer ${session.token}` },
  }).then(responseJson)
  const input = {
    ...submissionPayload,
    targetSessionId: session.id,
    clientSubmissionId: '20260712T120000000Z-concurrent-online',
  }

  const responses = await Promise.all([
    fetch(`${base}/api/projects/${projectId}/submissions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    }),
    fetch(`${base}/api/projects/${projectId}/submissions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    }),
  ])
  const bodies = await Promise.all(responses.map((response) => response.json()))
  const received = await waiting

  assert.deepEqual(responses.map(({ status }) => status), [201, 201], JSON.stringify(bodies))
  assert.equal(new Set(bodies.map(({ submissionId }) => submissionId)).size, 1)
  assert.deepEqual(bodies.map(({ status }) => status), ['received', 'received'])
  assert.equal(received.submissionId, bodies[0].submissionId)
  const metadata = JSON.parse(await readFile(
    join(selected.project.canvasDir, 'inbox', bodies[0].submissionId, 'metadata.json'),
    'utf8',
  ))
  assert.equal(metadata.status, 'received')
  assert.equal(metadata.receiverId, session.id)
})

test('restores a submission to pending when its session disappears during delivery', async (t) => {
  const { base, server } = await createFixture(t)
  const selected = await responseJson(await fetch(`${base}/api/projects/select-folder`, {
    method: 'POST',
  }))
  const projectId = selected.project.id
  const session = await postJson(`${base}/api/agent-sessions`, {
    projectId,
    label: 'Codex race',
    timeoutMs: 5000,
  })
  const originalCreateForDelivery = server.bridge.submissionStore.createForDelivery
  server.bridge.submissionStore.createForDelivery = async (...args) => {
    const routed = await originalCreateForDelivery(...args)
    if (routed.shouldDeliver) {
      assert.equal(server.bridge.broker.cancel(session.id, session.token), true)
    }
    return routed
  }

  const result = await postJson(`${base}/api/projects/${projectId}/submissions`, {
    ...submissionPayload,
    targetSessionId: session.id,
    clientSubmissionId: '20260712T120000000Z-delivery-race',
  })

  assert.equal(result.status, 'pending')
  const metadata = JSON.parse(await readFile(
    join(selected.project.canvasDir, 'inbox', result.submissionId, 'metadata.json'),
    'utf8',
  ))
  assert.equal(metadata.status, 'pending')
  assert.equal(metadata.receivedAt, null)
  assert.equal(Object.hasOwn(metadata, 'receiverId'), false)
})

test('lists, claims, and completes durable inbox submissions', async (t) => {
  const { base } = await createFixture(t)
  const selected = await responseJson(await fetch(`${base}/api/projects/select-folder`, {
    method: 'POST',
  }))
  const projectId = selected.project.id
  const created = await postJson(`${base}/api/projects/${projectId}/submissions`, {
    ...submissionPayload,
    targetSessionId: null,
    clientSubmissionId: '20260712T120000000Z-claim-test',
  })

  const inbox = await responseJson(await fetch(`${base}/api/projects/${projectId}/inbox`))
  assert.deepEqual(inbox.submissions.map(({ submissionId }) => submissionId), [created.submissionId])

  const claimed = await postJson(`${base}/api/projects/${projectId}/inbox/claim`, {
    receiverId: 'codex-cli',
  })
  assert.equal(claimed.decision, 'submitted')
  assert.equal(claimed.submissionId, created.submissionId)
  assert.equal(claimed.status, 'received')

  const completed = await postJson(`${base}/api/submissions/${created.submissionId}/complete`, {
    projectId,
  })
  assert.equal(completed.status, 'processed')
  assert.equal(completed.submissionId, created.submissionId)
  const processedMetadata = JSON.parse(await readFile(
    join(selected.project.canvasDir, 'processed', created.submissionId, 'metadata.json'),
    'utf8',
  ))
  assert.equal(processedMetadata.status, 'processed')

  const empty = await postJson(`${base}/api/projects/${projectId}/inbox/claim`, {
    receiverId: 'codex-cli',
  })
  assert.deepEqual(empty, { decision: 'empty' })
})
