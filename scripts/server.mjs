import { createReadStream, existsSync, realpathSync, statSync } from 'node:fs'
import { createServer } from 'node:http'
import { extname, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createBridgeApi } from './lib/http-api.mjs'
import { createProjectRegistry } from './lib/project-registry.mjs'
import { createSceneStore } from './lib/scene-store.mjs'
import { SessionBroker } from './lib/session-broker.mjs'
import { createSubmissionStore } from './lib/submission-store.mjs'
import { selectWindowsFolder } from './lib/windows-folder-picker.mjs'
import { homedir } from 'node:os'
import { createBoardStore } from './lib/board-store.mjs'
import { createServer as createPipeServer } from 'node:net'
import { createHash } from 'node:crypto'

const CONTENT_TYPES = new Map([
  ['.css', 'text/css; charset=utf-8'],
  ['.html', 'text/html; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.png', 'image/png'],
  ['.svg', 'image/svg+xml'],
  ['.webp', 'image/webp'],
  ['.woff2', 'font/woff2'],
])

export function contentTypeFor(pathname) {
  return CONTENT_TYPES.get(extname(pathname).toLowerCase()) ?? 'application/octet-stream'
}

export function resolveRequestFile(root, pathname) {
  let decoded
  try {
    decoded = decodeURIComponent(pathname)
  } catch {
    return null
  }

  const resolvedRoot = resolve(root)
  const relativePath = decoded.replace(/^[/\\]+/, '') || 'index.html'
  const candidate = resolve(resolvedRoot, relativePath)

  if (candidate !== resolvedRoot && !candidate.startsWith(`${resolvedRoot}${sep}`)) {
    return null
  }
  return candidate
}

export function isSameFilePath(firstPath, secondPath) {
  try {
    return realpathSync(firstPath) === realpathSync(secondPath)
  } catch {
    return false
  }
}

function existingFile(pathname) {
  return existsSync(pathname) && statSync(pathname).isFile()
}

export function startServer({
  root,
  port = 4173,
  host = '127.0.0.1',
  dataRoot,
  selectDirectory = selectWindowsFolder,
}) {
  if (host !== '127.0.0.1') {
    throw new TypeError('Bridge listener host must be 127.0.0.1')
  }
  const registry = createProjectRegistry({ dataRoot })
  const validateProject = (project) => registry.validate(project.id)
  const sceneStore = createSceneStore({ validateProject })
  const submissionStore = createSubmissionStore({ validateProject })
  const broker = new SessionBroker()
  const boardStore = createBoardStore({ registry, dataRoot: dataRoot ?? resolve(process.env.LOCALAPPDATA || homedir(), 'ExcalidrawAgentBridge') })
  const api = createBridgeApi({ registry, sceneStore, submissionStore, broker, selectDirectory, boardStore })

  function serveStatic(request, response, requestUrl) {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      response.writeHead(405, { Allow: 'GET, HEAD' })
      response.end('Method Not Allowed')
      return
    }

    let filePath = resolveRequestFile(root, requestUrl.pathname)
    if (!filePath) {
      response.writeHead(400)
      response.end('Bad Request')
      return
    }

    if (!existingFile(filePath)) {
      const isApplicationRoute = !extname(requestUrl.pathname)
      filePath = isApplicationRoute ? resolve(root, 'index.html') : filePath
    }

    if (!existingFile(filePath)) {
      response.writeHead(404)
      response.end('Not Found')
      return
    }

    response.writeHead(200, {
      'Cache-Control': 'no-cache',
      'Content-Type': contentTypeFor(filePath),
      'X-Content-Type-Options': 'nosniff',
    })
    if (request.method === 'HEAD') {
      response.end()
      return
    }
    createReadStream(filePath).pipe(response)
  }

  const server = createServer((request, response) => {
    const requestUrl = new URL(request.url ?? '/', `http://${host}:${port}`)
    Promise.resolve(api.handle(request, response, requestUrl))
      .then((handled) => {
        if (!handled) serveStatic(request, response, requestUrl)
      })
      .catch(() => {
        if (response.headersSent) {
          response.end()
          return
        }
        if (requestUrl.pathname === '/api' || requestUrl.pathname.startsWith('/api/')) {
          const body = JSON.stringify({
            error: { code: 'INTERNAL_ERROR', message: 'Internal server error' },
          })
          response.writeHead(500, {
            'Cache-Control': 'no-store',
            'Content-Length': Buffer.byteLength(body),
            'Content-Type': 'application/json; charset=utf-8',
            'X-Content-Type-Options': 'nosniff',
          })
          response.end(body)
          return
        }
        response.writeHead(500)
        response.end('Internal Server Error')
      })
  })

  server.bridge = { api, broker, registry, sceneStore, submissionStore, boardStore }

  const listen = () => server.listen(port, host, () => {
    const address = server.address()
    const listeningPort = typeof address === 'object' && address ? address.port : port
    console.log(`Excalidraw Local: http://${host}:${listeningPort}`)
  })
  if (process.platform === 'win32') {
    // OS-owned named pipe acts as an instance lock; process death releases it.
    // A second HTTP port must not bypass ownership of the same data catalog.
    const identity = resolve(dataRoot ?? resolve(process.env.LOCALAPPDATA || homedir(), 'ExcalidrawAgentBridge')).toLowerCase()
    const key = createHash('sha256').update(identity).digest('hex').slice(0, 24)
    const lock = createPipeServer(socket => socket.destroy())
    lock.once('error', error => server.emit('error', Object.assign(new Error(`AgentCanvas data directory already in use: ${error.message}`), { code: 'STORE_IN_USE' })))
    server.once('close', () => lock.close())
    server.once('error', () => lock.close())
    lock.listen(`\\\\.\\pipe\\agentcanvas-${key}`, listen)
  } else listen()
  return server
}

const isMainModule = process.argv[1]
  ? isSameFilePath(fileURLToPath(import.meta.url), resolve(process.argv[1]))
  : false

if (isMainModule) {
  const scriptDirectory = resolve(fileURLToPath(new URL('.', import.meta.url)))
  const projectRoot = resolve(scriptDirectory, '..')
  const portFlagIndex = process.argv.indexOf('--port')
  const requestedPort = portFlagIndex >= 0 ? Number(process.argv[portFlagIndex + 1]) : 4173
  const port = Number.isInteger(requestedPort) && requestedPort > 0 ? requestedPort : 4173
  startServer({ root: resolve(projectRoot, 'dist'), port })
}
