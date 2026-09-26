import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { once } from 'node:events'
import { startServer } from './server.mjs'
import { runBoardCli } from './lib/board-cli.mjs'

test('open registers exact path, validates visible handshake, persists binding and receives/completes', async t => {
  const root = await mkdtemp(join(tmpdir(), 'canvas-cli-bound-'))
  const project = join(root, '项目 with spaces'); await mkdir(project)
  const server = startServer({ root, port: 0, dataRoot: join(root, 'registry') })
  await once(server, 'listening'); t.after(() => { server.closeAllConnections(); server.close() })
  const base = `http://127.0.0.1:${server.address().port}`
  const output = []; const errors = []
  const deps = { cwd: project, ensureServer: async () => {}, stdout: line => output.push(JSON.parse(line)), stderr: line => errors.push(line),
    fetch: (url, init) => fetch(String(url).replace('http://127.0.0.1:4173', base), init),
    openBrowser: async url => {
      const params = new URL(url).searchParams
      await server.bridge.boardStore.presence(params.get('board'), { windowId: 'test-visible-window', launchId: params.get('launch'), visible: true })
    },
  }
  assert.equal(await runBoardCli(['open', '--conversation', 'codex:case-1', '--name', '可靠画板'], deps), 0)
  const first = output.at(-1)
  assert.equal(first.decision, 'opened'); assert.equal(first.pageVisible, true)
  assert.match(first.next, /--timeout 120$/)
  assert.equal(first.receiveTimeoutSeconds, 120)
  assert.match(first.userNotice, /画完.*提交/)
  assert.equal(await runBoardCli(['open', '--conversation', 'codex:case-1'], deps), 0)
  assert.equal(output.at(-1).boardId, first.boardId)
  assert(!JSON.stringify(output).includes('receiverToken'))
  const boardId = first.boardId
  await server.bridge.boardStore.save(boardId, { baseRevision: 0, scene: { type: 'excalidraw', version: 2, source: 'test', elements: [{ id: 'r' }], files: {}, appState: {} } })
  await server.bridge.boardStore.submit(boardId, { clientSubmissionId: 'cli-submission-0001', sceneRevision: 1 })
  assert.equal(await runBoardCli(['receive', '--board', boardId, '--timeout', '0'], deps), 0)
  assert.equal(output.at(-1).decision, 'submitted'); assert.equal(output.at(-1).claimToken, undefined)
  assert.equal(await runBoardCli(['complete', 'cli-submission-0001', '--board', boardId], deps), 0)
  assert.equal(output.at(-1).decision, 'completed')
  assert.equal(await runBoardCli(['receive', '--board', boardId, '--timeout', '0'], deps), 0)
  assert.equal(output.at(-1).decision, 'empty'); assert.deepEqual(errors, [])
})

test('browser invocation without page handshake never reports opened', async () => {
  const id = '11111111-1111-4111-8111-111111111111'
  const root = await mkdtemp(join(tmpdir(), 'canvas-cli-unconfirmed-'))
  const stdout = []
  const replies = [{ protocol: 2 }, { project: { id, rootPath: root } }, { board: { id, conversation: 'test' }, receiverToken: 'test-only' }, { launchId: 'launch' }, { pageLoaded: false, pageVisible: false }]
  const result = await runBoardCli(['open', '--conversation', 'test'], {
    cwd: root, ensureServer: async () => {}, stdout: line => stdout.push(JSON.parse(line)), stderr: () => {}, handshakeTimeoutMs: 0,
    openBrowser: async () => {}, fetch: async () => new Response(JSON.stringify(replies.shift())),
  })
  assert.equal(result, 2); assert.equal(stdout.at(-1).decision, 'browser-unconfirmed')
  assert.equal(stdout.at(-1).userNotice, undefined)
  assert.equal(stdout.at(-1).next, 'agent-canvas doctor')
})

async function receiveFixture() {
  const root = await mkdtemp(join(tmpdir(), 'canvas-receive-deadline-'))
  const id = '22222222-2222-4222-8222-222222222222'
  const dir = join(root, '.agent-canvas', 'connections'); await mkdir(dir, { recursive: true })
  const path = join(dir, `${id}.json`)
  await writeFile(path, JSON.stringify({ receiverToken: 'fixture-token', boardId: id }))
  return { root, id, path }
}

test('default receive waits 120 seconds in bounded requests with one identity and one result', async () => {
  const f = await receiveFixture(); let time = 0; const requests = []; const output = []
  const result = await runBoardCli(['receive', '--board', f.id], {
    cwd: f.root, now: () => time, stdout: x => output.push(JSON.parse(x)), stderr: assert.fail,
    fetch: async (url, init) => { const body = JSON.parse(init.body); requests.push(body); time += body.waitMs; return new Response(JSON.stringify({ decision: 'empty', boardId: f.id })) },
  })
  assert.equal(result, 0); assert.equal(time, 120_000); assert.equal(requests.length, 6)
  assert(requests.every(x => x.waitMs === 20_000)); assert.equal(new Set(requests.map(x => x.requestId)).size, 1)
  assert.equal(output.length, 1); assert.equal(output[0].decision, 'empty')
  assert.equal(JSON.parse(await readFile(f.path)).pendingReceiveId, undefined)
})

test('receive 120 returns a late submission immediately and saves its private claim', async () => {
  const f = await receiveFixture(); let time = 0; let calls = 0; const output = []
  assert.equal(await runBoardCli(['receive', '--board', f.id, '--timeout', '120'], {
    cwd: f.root, now: () => time, stdout: x => output.push(JSON.parse(x)), stderr: assert.fail,
    fetch: async () => { calls++; time += calls === 1 ? 20_000 : 7_000; return new Response(JSON.stringify(calls === 1 ? { decision: 'empty' } : { decision: 'submitted', submissionId: 'late-submission', claimToken: 'fixture-claim' })) },
  }), 0)
  assert.equal(time, 27_000); assert.equal(calls, 2); assert.equal(output[0].decision, 'submitted')
  assert.equal(output[0].claimToken, undefined)
  assert.equal(JSON.parse(await readFile(f.path)).claims['late-submission'], 'fixture-claim')
})

test('receive uses remaining budget, keeps zero timeout immediate, and preserves retry identity on failure', async () => {
  const f = await receiveFixture(); let time = 0; const waits = []
  const deps = { cwd: f.root, now: () => time, stdout: () => {}, stderr: () => {}, fetch: async (url, init) => { const body = JSON.parse(init.body); waits.push(body.waitMs); time += body.waitMs; return new Response('{"decision":"empty"}') } }
  assert.equal(await runBoardCli(['receive', '--board', f.id, '--timeout', '21'], deps), 0)
  assert.deepEqual(waits, [20_000, 1_000])
  waits.length = 0
  assert.equal(await runBoardCli(['receive', '--board', f.id, '--timeout', '0'], deps), 0); assert.deepEqual(waits, [0])
  let calls = 0; let requestId
  assert.equal(await runBoardCli(['receive', '--board', f.id], { ...deps, fetch: async (url, init) => { calls++; requestId = JSON.parse(init.body).requestId; if(calls === 2) throw new Error('connection lost'); time += 20_000; return new Response('{"decision":"empty"}') } }), 1)
  assert.equal(JSON.parse(await readFile(f.path)).pendingReceiveId, requestId)
  assert.equal(await runBoardCli(['receive', '--board', f.id, '--timeout', '0'], { ...deps, fetch: async (url, init) => { assert.equal(JSON.parse(init.body).requestId, requestId); return new Response('{"decision":"busy"}') } }), 0)
})

test('invalid receive timeouts are rejected before touching connection files', async () => {
  for (const seconds of ['-1','121','0.5','NaN','Infinity']) {
    let error
    assert.equal(await runBoardCli(['receive', '--board', '22222222-2222-4222-8222-222222222222', '--timeout', seconds], { cwd: tmpdir(), stdout: assert.fail, stderr: x => { error = x }, fetch: assert.fail }), 1)
    assert.match(error, /0-120|Missing value/)
  }
})

test('a second Windows service cannot share the same data root on another port', { skip: process.platform !== 'win32' }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'canvas-instance-lock-'))
  const dataRoot = join(root, 'registry')
  const first = startServer({ root, dataRoot, port: 0 })
  await once(first, 'listening')
  t.after(() => { first.closeAllConnections(); first.close() })
  const second = startServer({ root, dataRoot, port: 0 })
  const [error] = await once(second, 'error')
  assert.equal(error.code, 'STORE_IN_USE')
})
