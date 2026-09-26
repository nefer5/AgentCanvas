import { execFile } from 'node:child_process'
import { mkdir, readFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { promisify } from 'node:util'
import { writeJsonAtomic } from './atomic-files.mjs'
import { createServer } from 'node:net'
import { createHash, randomUUID } from 'node:crypto'
const execute = promisify(execFile)
const BASE = 'http://127.0.0.1:4173'
const DEFAULT_RECEIVE_SECONDS = 120
const RECEIVE_REQUEST_MS = 20_000
const COMMANDS = new Set(['open', 'doctor', 'status', 'receive', 'renew', 'release'])
export const isBoardCommand = args => COMMANDS.has(args[0]) || (args[0] === 'complete' && args.includes('--board'))
const HELP = `Agent Canvas：稳定画板与聊天绑定

  agent-canvas open --project <目录> --conversation <工具:聊天ID> [--name <名称>] [--board <ID>]
  agent-canvas doctor
  agent-canvas status --project <目录> --board <ID>
  agent-canvas receive --project <目录> --board <ID> [--timeout <0-120秒，默认120>]
  agent-canvas renew|release|complete <提交ID> --project <目录> --board <ID>

open 通过系统默认浏览器打开可见页面，等待页面握手；重复调用恢复同一绑定。
打开成功后先向用户说明“画板已打开，请画完点击提交，我会等待最多120秒”，再执行 receive。
receive 默认等待120秒，有提交立即返回；CLI内部维持短请求，不需要模型反复轮询或隐藏后台进程。
timeout 0只立即领取，status只读不领取。empty表示本次等待已结束；不会唤醒已结束聊天。
处理超过两分钟必须 renew。领取凭据自动保存在项目 .agent-canvas/connections 中。
doctor/status 不消费提交，不自动重启服务。旧 wait/inbox 属于旧版项目画板。
`
function parse(args) {
  const options = {}; const positionals = []
  for (let i = 1; i < args.length; i++) {
    const name = args[i]
    if (!name.startsWith('--')) { positionals.push(name); continue }
    if (!['--project', '--conversation', '--board', '--name', '--timeout'].includes(name)) throw new Error(`Unknown option: ${name}`)
    if (options[name] !== undefined) throw new Error(`Duplicate option: ${name}`)
    const value = args[++i]
    if (!value || value.startsWith('--')) throw new Error(`Missing value: ${name}`)
    options[name] = value
  }
  if (positionals.length > (['renew', 'release', 'complete'].includes(args[0]) ? 1 : 0)) throw new Error('Unexpected positional argument')
  return { options, positionals }
}
async function call(fetch, path, body, token) {
  const response = await fetch(BASE + path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(25_000),
  })
  const result = await response.json()
  if (!response.ok) throw Object.assign(new Error(result.error?.message ?? `HTTP ${response.status}`), { code: result.error?.code })
  return result
}
function connectionPath(project, id) {
  if (!/^[0-9a-f-]{36}$/i.test(id ?? '')) throw new Error('--board must be a valid board ID')
  return join(project, '.agent-canvas', 'connections', `${id}.json`)
}
async function writeConnection(path, value) {
  // Tokens never appear in URLs or stdout. The file is local project state.
  await writeJsonAtomic(path, value, { createParent: false })
}
export async function openVisibleBrowser(url) {
  if (process.platform !== 'win32') throw new Error('Visible launcher currently supports Windows only')
  const script = `Start-Process -FilePath '${url.replaceAll("'", "''")}' -ErrorAction Stop`
  await execute('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { windowsHide: true })
}
export async function runBoardCli(args, dependencies) {
  const { fetch, cwd, ensureServer, stdout, stderr } = dependencies
  const now = dependencies.now ?? (() => performance.now())
  let clientLock
  const lockConnection = async path => {
    if (process.platform !== 'win32') return
    const key = createHash('sha256').update(path.toLowerCase()).digest('hex').slice(0, 24)
    clientLock = createServer(socket => socket.destroy())
    await new Promise((resolve, reject) => {
      clientLock.once('error', () => reject(Object.assign(new Error('Another command is using this board connection; wait for it to finish'), { code: 'CLIENT_BUSY' })))
      clientLock.listen(`\\\\.\\pipe\\agentcanvas-client-${key}`, resolve)
    })
  }
  if (args.includes('--help') || args.includes('-h')) { stdout(HELP); return 0 }
  try {
    const { options, positionals } = parse(args)
    const command = args[0]
    const project = resolve(options['--project'] ?? cwd)
    if (command === 'doctor') {
      const result = await call(fetch, '/api/status')
      stdout(JSON.stringify({ decision: 'diagnosed', node: process.version, endpoint: BASE, ...result })); return 0
    }
    if (command === 'open') {
      if (!options['--conversation']) throw new Error('--conversation is required: use a stable, namespaced tool/chat identity')
      await ensureServer()
      const health = await call(fetch, '/api/status')
      if (health.protocol !== 2) throw new Error('Service protocol mismatch; use the official launcher to update the local service')
      const registered = await call(fetch, '/api/projects/register', { rootPath: project })
      const result = await call(fetch, '/api/boards', { projectId: registered.project.id, conversation: options['--conversation'], name: options['--name'] ?? options['--conversation'], boardId: options['--board'] ?? null })
      const path = connectionPath(project, result.board.id)
      await lockConnection(path)
      await mkdir(join(project, '.agent-canvas', 'connections'), { recursive: true })
      let prior = {}; try { prior = JSON.parse(await readFile(path, 'utf8')) } catch (error) { if (error.code !== 'ENOENT') throw error }
      await writeConnection(path, { ...prior, boardId: result.board.id, conversation: options['--conversation'], receiverToken: result.receiverToken })
      const { launchId } = await call(fetch, `/api/boards/${result.board.id}/launch`, {})
      const url = `${BASE}/?board=${encodeURIComponent(result.board.id)}&launch=${encodeURIComponent(launchId)}`
      await (dependencies.openBrowser ?? openVisibleBrowser)(url)
      let handshake = { pageLoaded: false, pageVisible: false }
      const deadline = Date.now() + (dependencies.handshakeTimeoutMs ?? 15_000)
      do {
        handshake = await call(fetch, `/api/launches/${launchId}`)
        if (handshake.pageLoaded && handshake.pageVisible) break
        await new Promise(resolve => setTimeout(resolve, 500))
      } while (Date.now() < deadline)
      stdout(JSON.stringify({ decision: handshake.pageVisible ? 'opened' : 'browser-unconfirmed', boardId: result.board.id, projectRoot: registered.project.rootPath, binding: result.board.conversation, url, ...handshake, receiveMode: 'poll', receiverReachable: false, receiveTimeoutSeconds: DEFAULT_RECEIVE_SECONDS, ...(handshake.pageVisible ? { userNotice: '画板已打开，请画完后点击提交。我接下来会等待最多120秒接收提交。' } : {}), next: handshake.pageVisible ? `agent-canvas receive --project "${project}" --board ${result.board.id} --timeout ${DEFAULT_RECEIVE_SECONDS}` : 'agent-canvas doctor' }))
      return handshake.pageVisible ? 0 : 2
    }
    const id = options['--board']; const path = connectionPath(project, id)
    if (command === 'status') { stdout(JSON.stringify(await call(fetch, `/api/boards/${id}/status`))); return 0 }
    const seconds = command === 'receive' ? Number(options['--timeout'] ?? DEFAULT_RECEIVE_SECONDS) : null
    if (command === 'receive' && (!Number.isInteger(seconds) || seconds < 0 || seconds > DEFAULT_RECEIVE_SECONDS)) throw new Error('--timeout must be 0-120 seconds')
    await lockConnection(path)
    const connection = JSON.parse(await readFile(path, 'utf8'))
    if (command === 'receive') {
      connection.pendingReceiveId ??= randomUUID()
      await writeConnection(path, connection)
      // One user-visible wait, several bounded HTTP requests. Compatible with
      // existing protocol-2 services; preserves the same request/claim identity.
      const deadline = now() + seconds * 1000
      let result
      do {
        const remaining = Math.max(0, Math.ceil(deadline - now()))
        result = await call(fetch, `/api/boards/${id}/receive`, { waitMs: Math.min(RECEIVE_REQUEST_MS, remaining), requestId: connection.pendingReceiveId }, connection.receiverToken)
        if (result.decision !== 'empty' || seconds === 0 || now() >= deadline) break
      } while (true)
      if (result.decision === 'submitted') {
        connection.claims ??= {}; connection.claims[result.submissionId] = result.claimToken
      }
      delete connection.pendingReceiveId
      await writeConnection(path, connection)
      const { claimToken, ...publicResult } = result
      stdout(JSON.stringify(publicResult)); return 0
    }
    const submissionId = positionals[0]
    if (!submissionId || !connection.claims?.[submissionId]) throw new Error('No saved claim for this submission; receive it first')
    const result = await call(fetch, `/api/boards/${id}/${command}`, { submissionId, claimToken: connection.claims[submissionId] }, connection.receiverToken)
    stdout(JSON.stringify(result)); return 0
  } catch (error) {
    stderr(JSON.stringify({ error: { code: error.code ?? error.cause?.code ?? 'BOARD_CLI_ERROR', message: error.message } })); return 1
  } finally {
    if (clientLock?.listening) await new Promise(resolve => clientLock.close(resolve))
  }
}
