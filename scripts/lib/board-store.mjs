import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { mkdir, readdir, lstat, realpath, rename } from 'node:fs/promises'
import { join, relative, isAbsolute } from 'node:path'
import { readJsonOptional, writeJsonAtomic, writeFileAtomic } from './atomic-files.mjs'
import { createSceneStore } from './scene-store.mjs'
import { KeyedSerializer } from './keyed-serializer.mjs'
import { snapshotUsage } from './bounded-snapshots.mjs'

const UUID = /^[0-9a-f-]{36}$/i
const WINDOW_TTL = 20_000
const LEASE_MS = 120_000
export function boardError(status, code, message) {
  return Object.assign(new Error(message), { status, code })
}
function text(value, label, max = 160) {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new TypeError(`${label} is required (1-${max} characters)`)
  return value.trim()
}
function tokenEquals(a, b) {
  const x = Buffer.from(String(a ?? '')); const y = Buffer.from(String(b ?? ''))
  return x.length > 0 && x.length === y.length && timingSafeEqual(x, y)
}
async function safeDirectory(path, parent) {
  const info = await lstat(path)
  if (!info.isDirectory() || info.isSymbolicLink()) throw boardError(409, 'UNSAFE_PATH', 'Managed directory must not be a link')
  const actual = await realpath(path)
  if (parent) {
    const part = relative(await realpath(parent), actual)
    if (part.startsWith('..') || isAbsolute(part)) throw boardError(409, 'UNSAFE_PATH', 'Managed directory escaped its parent')
  }
  return actual
}
async function bytesIn(path) {
  let bytes = 0
  for (const item of await readdir(path, { withFileTypes: true })) {
    const child = join(path, item.name)
    const info = await lstat(child)
    if (info.isSymbolicLink()) throw boardError(409, 'UNSAFE_PATH', 'Storage contains a symbolic link')
    bytes += info.isDirectory() ? await bytesIn(child) : info.size
  }
  return bytes
}

export function createBoardStore({ registry, dataRoot, now = () => Date.now() }) {
  const indexPath = join(dataRoot, 'boards.json')
  const serial = new KeyedSerializer()
  const windows = new Map()
  const receivers = new Map()
  const launches = new Map()
  const epoch = randomUUID()
  const startedAt = now()
  const sceneStore = createSceneStore()
  const exclusive = operation => serial.run('boards', operation)
  const timestamp = () => new Date(now()).toISOString()
  async function index() {
    const value = await readJsonOptional(indexPath) ?? { schemaVersion: 1, boards: [] }
    if (value.schemaVersion !== 1 || !Array.isArray(value.boards)) throw boardError(500, 'BOARD_INDEX_INVALID', 'Board index is invalid')
    return value
  }
  async function record(id, { allowTrash = false } = {}) {
    if (!UUID.test(id)) throw new TypeError('Invalid board ID')
    const catalog = await index()
    const board = catalog.boards.find(item => item.id === id)
    if (!board) throw boardError(404, 'BOARD_NOT_FOUND', '画板不存在')
    if (!allowTrash && board.state === 'trashed') throw boardError(410, 'BOARD_TRASHED', '画板已移入回收站，请先恢复')
    const project = await registry.validate(board.projectId)
    const area = board.state === 'trashed' ? 'board-trash' : 'boards'
    const parent = join(project.canvasDir, area)
    await safeDirectory(parent, project.canvasDir)
    let canvasDir
    try { canvasDir = await safeDirectory(join(parent, id), parent) }
    catch (error) {
      if (error.code !== 'ENOENT') throw error
      // Finish a same-volume recycle/restore interrupted after rename but before
      // committing the catalog. Never create an empty replacement board.
      const alternateParent = join(project.canvasDir, board.state === 'trashed' ? 'boards' : 'board-trash')
      await safeDirectory(alternateParent, project.canvasDir)
      const alternate = await safeDirectory(join(alternateParent, id), alternateParent)
      const manifest = await readJsonOptional(join(alternate, 'recycle-manifest.json'))
      if (manifest?.board?.id !== id || manifest.board.projectId !== board.projectId) throw boardError(409, 'RECOVERY_REQUIRED', '回收记录无法验证，请保留文件并检查')
      board.state = board.state === 'trashed' ? 'archived' : 'trashed'; board.revision++
      await writeJsonAtomic(indexPath, catalog)
      if (!allowTrash && board.state === 'trashed') throw boardError(410, 'BOARD_TRASHED', '画板已移入回收站，请先恢复')
      canvasDir = alternate
    }
    return { catalog, board, project, canvasDir, sceneProject: { ...project, canvasDir } }
  }
  function publicBoard(board) {
    const { receiverToken, ...publicData } = board
    return publicData
  }
  function activeWindows(id) {
    const entries = windows.get(id) ?? new Map()
    return [...entries.values()].filter(value => now() - value.at <= WINDOW_TTL)
  }
  async function loadWindows(item) {
    if (!windows.has(item.board.id)) {
      const saved = await readJsonOptional(join(item.canvasDir, 'presence.json')) ?? []
      windows.set(item.board.id, new Map(saved))
    }
    return windows.get(item.board.id)
  }
  async function jobs(item) {
    const path = join(item.canvasDir, 'jobs.json')
    const info = await lstat(path)
    if (!info.isFile() || info.isSymbolicLink()) throw boardError(409, 'UNSAFE_PATH', '任务索引不是普通文件')
    const value = await readJsonOptional(path)
    if (!Array.isArray(value)) throw boardError(500, 'JOBS_INVALID', '任务索引损坏')
    return value
  }
  async function saveJobs(item, value) { await writeJsonAtomic(join(item.canvasDir, 'jobs.json'), value, { createParent: false }) }
  function auth(board, token) {
    if (!tokenEquals(board.receiverToken, token)) throw boardError(401, 'UNAUTHORIZED', '当前聊天的接收凭据不匹配')
  }
  async function stats(item) {
    const allWindows = await loadWindows(item)
    const list = await jobs(item)
    return {
      board: publicBoard(item.board), epoch,
      windows: activeWindows(item.board.id).length,
      unknownWindows: allWindows.size - activeWindows(item.board.id).length,
      receiverOnline: now() - (receivers.get(item.board.id) ?? -Infinity) < 30_000,
      pending: list.filter(job => job.status === 'pending').length,
      processing: list.filter(job => job.status === 'processing').length,
      lastSubmission: list.length ? { id: list.at(-1).id, status: list.at(-1).status, createdAt: list.at(-1).createdAt } : null,
      checkedAt: timestamp(),
    }
  }
  async function protection(item) {
    const reasons = []
    if (now() - startedAt < WINDOW_TTL) reasons.push('服务刚启动，正在确认活动窗口')
    if (item.board.favorite) reasons.push('已收藏')
    const entries = await loadWindows(item)
    if (activeWindows(item.board.id).length) reasons.push('有窗口正在使用')
    if (entries.size > activeWindows(item.board.id).length) reasons.push('有失联窗口，需明确解除保护')
    if ((await jobs(item)).some(job => job.status !== 'completed')) reasons.push('存在待接收或处理中的提交')
    if ((await readdir(join(item.canvasDir, 'versions'))).some(name => name.startsWith('conflict-')) || (await snapshotUsage(item.canvasDir)).conflicts > 0) reasons.push('有未解决的冲突副本')
    return reasons
  }
  return {
    epoch,
    async open({ projectId, conversation = null, name = '未命名画板', boardId = null }) {
      if (conversation !== null) conversation = text(conversation, 'conversation', 500)
      name = text(name, 'name')
      return exclusive(async () => {
        const project = await registry.validate(projectId)
        const catalog = await index()
        let board = boardId ? catalog.boards.find(item => item.id === boardId) : conversation && catalog.boards.find(item => item.projectId === projectId && item.conversation === conversation)
        if (boardId && !board) throw boardError(404, 'BOARD_NOT_FOUND', '画板不存在')
        if (board) {
          await record(board.id)
          if (board.projectId !== projectId || (board.conversation && board.conversation !== conversation)) throw boardError(409, 'BINDING_CONFLICT', '画板已经绑定其他项目或聊天，不能自动转交')
          if (!board.conversation && conversation) { board.conversation = conversation; board.revision++; await writeJsonAtomic(indexPath, catalog) }
        } else {
          board = { id: randomUUID(), projectId, name, conversation, state: 'active', favorite: false, createdAt: timestamp(), updatedAt: timestamp(), revision: 1, receiverToken: randomBytes(32).toString('base64url') }
          const parent = join(project.canvasDir, 'boards')
          await mkdir(parent, { recursive: true }); await safeDirectory(parent, project.canvasDir)
          const path = join(parent, board.id)
          await mkdir(path)
          for (const dir of ['current', 'versions', 'submissions']) await mkdir(join(path, dir))
          await writeJsonAtomic(join(path, 'jobs.json'), [])
          catalog.boards.push(board)
          await writeJsonAtomic(indexPath, catalog)
        }
        return { board: publicBoard(board), receiverToken: board.receiverToken }
      })
    },
    async list({ projectId = null, state = null, query = '', offset = 0, limit = 12 } = {}) {
      if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 50) throw new TypeError('Invalid pagination')
      return exclusive(async () => {
        const catalog = await index()
        const result = []
        const candidates = catalog.boards.filter(board => (!projectId || board.projectId === projectId) && (!state || state === 'all' || board.state === state) && `${board.name} ${board.conversation ?? ''}`.toLowerCase().includes(String(query).toLowerCase())).sort((a, b) => Number(b.favorite) - Number(a.favorite) || b.updatedAt.localeCompare(a.updatedAt))
        for (const board of candidates.slice(offset, offset + limit)) {
          try {
            const item = await record(board.id, { allowTrash: true })
            const document = await sceneStore.load(item.sceneProject)
            const preview = (document.scene?.elements ?? []).filter(element => !element.isDeleted).slice(0, 80).map(({ type, x, y, width, height }) => ({ type, x, y, width, height }))
            result.push({ ...publicBoard(item.board), preview, projectName: item.project.name, bytes: await bytesIn(item.canvasDir), available: true, protectedReasons: await protection(item) })
          } catch (error) {
            result.push({ ...publicBoard(board), available: false, bytes: null, protectedReasons: ['无法核实状态'], error: error.message })
          }
        }
        return { boards: result, total: candidates.length, offset, limit }
      })
    },
    async get(id) { return exclusive(async () => publicBoard((await record(id)).board)) },
    async status(id) { return exclusive(async () => stats(await record(id))) },
    async presence(id, { windowId, visible, launchId, leave = false }) {
      text(windowId, 'windowId')
      return exclusive(async () => {
        const item = await record(id)
        const entries = await loadWindows(item)
        if (leave) entries.delete(windowId)
        else entries.set(windowId, { at: now(), visible: visible === true })
        windows.set(id, entries)
        await writeJsonAtomic(join(item.canvasDir, 'presence.json'), [...entries], { createParent: false })
        const launch = launches.get(launchId)
        if (launch && launch.boardId === id) { launch.pageLoaded = true; launch.pageVisible = visible === true }
        return { epoch, checkedAt: timestamp() }
      })
    },
    async releaseWindows(id) {
      return exclusive(async () => {
        const item = await record(id)
        const entries = await loadWindows(item)
        if (activeWindows(id).length) throw boardError(409, 'BOARD_IN_USE', '仍有活跃窗口，不能解除保护')
        entries.clear()
        await writeJsonAtomic(join(item.canvasDir, 'presence.json'), [], { createParent: false })
        return { decision: 'released-stale-windows' }
      })
    },
    async launch(id) {
      await record(id)
      for (const [key, value] of launches) if (now() - value.at > 120_000) launches.delete(key)
      const launchId = randomUUID()
      launches.set(launchId, { boardId: id, at: now(), pageLoaded: false, pageVisible: false })
      return { launchId }
    },
    launchStatus(id) {
      const launch = launches.get(id)
      if (!launch) throw boardError(404, 'LAUNCH_NOT_FOUND', '打开请求已过期')
      return { boardId: launch.boardId, pageLoaded: launch.pageLoaded, pageVisible: launch.pageVisible }
    },
    async load(id) { return exclusive(async () => sceneStore.load((await record(id)).sceneProject)) },
    async versions(id, input) { return exclusive(async () => sceneStore.versions((await record(id)).sceneProject, input)) },
    async save(id, input) {
      return exclusive(async () => {
        const item = await record(id)
        const current = await sceneStore.load(item.sceneProject)
        // Preserve compare-and-set semantics even for identical stale data.
        if (current.revision === input.baseRevision && JSON.stringify(current.scene) === JSON.stringify(input.scene)) return { revision: current.revision, updatedAt: current.updatedAt }
        const saved = await sceneStore.save(item.sceneProject, input)
        item.board.updatedAt = timestamp(); item.board.revision++
        await writeJsonAtomic(indexPath, item.catalog)
        return saved
      })
    },
    async update(id, input) {
      return exclusive(async () => {
        const item = await record(id)
        if (input.name !== undefined) item.board.name = text(input.name, 'name')
        if (typeof input.favorite === 'boolean') item.board.favorite = input.favorite
        if (input.state === 'archived' && (await jobs(item)).some(job => job.status !== 'completed')) throw boardError(409, 'BOARD_IN_USE', '请先完成或处理待接收任务，再归档')
        if (input.state === 'active' || input.state === 'archived') item.board.state = input.state
        item.board.revision++; item.board.updatedAt = timestamp()
        await writeJsonAtomic(indexPath, item.catalog)
        return publicBoard(item.board)
      })
    },
    async submit(id, input) {
      return exclusive(async () => {
        const item = await record(id)
        if (!/^[a-zA-Z0-9_-]{8,121}$/.test(input.clientSubmissionId)) throw new TypeError('Invalid submission ID')
        const list = await jobs(item)
        const existing = list.find(job => job.id === input.clientSubmissionId)
        if (existing) return { submissionId: existing.id, status: 'pending', boardId: id }
        const current = await sceneStore.load(item.sceneProject)
        if (current.revision !== input.sceneRevision) throw boardError(409, 'SCENE_CONFLICT', '提交版本已变化，请重新检查画板')
        if (!current.scene) throw new TypeError('Cannot submit an empty board')
        const note = typeof input.note === 'string' ? input.note : ''
        if (note.length > 4000) throw new TypeError('Note too long')
        await safeDirectory(join(item.canvasDir, 'submissions'), item.canvasDir)
        const scenePath = join(item.canvasDir, 'submissions', `${input.clientSubmissionId}.json`)
        await writeJsonAtomic(scenePath, current.scene, { createParent: false })
        let hasPreview = false
        if (input.svg !== undefined || input.pngDataUrl !== undefined) {
          if (typeof input.svg !== 'string' || Buffer.byteLength(input.svg) > 10 * 1024 * 1024 || !/^data:image\/png;base64,[a-zA-Z0-9+/=]+$/.test(input.pngDataUrl ?? '')) throw new TypeError('Invalid submission previews')
          const png = Buffer.from(input.pngDataUrl.split(',')[1], 'base64')
          if (png.length > 20 * 1024 * 1024) throw new TypeError('PNG preview too large')
          await writeFileAtomic(scenePath.replace(/\.json$/, '.svg'), input.svg, { createParent: false })
          await writeFileAtomic(scenePath.replace(/\.json$/, '.png'), png, { createParent: false })
          hasPreview = true
        }
        list.push({ id: input.clientSubmissionId, hasPreview, status: 'pending', note, sceneRevision: current.revision, createdAt: timestamp(), claimToken: null, leaseUntil: null })
        await saveJobs(item, list)
        return { submissionId: input.clientSubmissionId, status: 'pending', boardId: id }
      })
    },
    async receive(id, token, requestId = 'direct-store-call') {
      return exclusive(async () => {
        const item = await record(id); auth(item.board, token)
        receivers.set(id, now())
        await safeDirectory(join(item.canvasDir, 'submissions'), item.canvasDir)
        const list = await jobs(item)
        // Redelivery retains the same claim until its lease expires, so a lost HTTP
        // response can be retried without orphaning the work.
        let job = list.find(value => value.status === 'processing')
        if (!job) job = list.find(value => value.status === 'pending')
        if (!job) return { decision: 'empty', boardId: id }
        if (job.status === 'processing' && job.leaseUntil > now() && job.receiveRequestId !== requestId) return { decision: 'busy', boardId: id, submissionId: job.id, leaseUntil: job.leaseUntil }
        if (job.status === 'pending' || job.leaseUntil <= now()) { job.claimToken = randomBytes(24).toString('base64url'); job.receiveRequestId = requestId }
        job.status = 'processing'; job.leaseUntil = now() + LEASE_MS
        await saveJobs(item, list)
        return { decision: 'submitted', boardId: id, submissionId: job.id, claimToken: job.claimToken, leaseUntil: job.leaseUntil, note: job.note, ...(job.hasPreview ? { pngPath: join(item.canvasDir, 'submissions', `${job.id}.png`), svgPath: join(item.canvasDir, 'submissions', `${job.id}.svg`) } : {}), scenePath: join(item.canvasDir, 'submissions', `${job.id}.json`), scene: await readJsonOptional(join(item.canvasDir, 'submissions', `${job.id}.json`)) }
      })
    },
    async transition(id, token, input, operation) {
      return exclusive(async () => {
        const item = await record(id); auth(item.board, token)
        const list = await jobs(item)
        const job = list.find(value => value.id === input.submissionId)
        if (!job || !tokenEquals(job.claimToken, input.claimToken)) throw boardError(409, 'CLAIM_MISMATCH', '领取已失效或不属于当前处理者')
        if (operation === 'complete' && job.status === 'completed') return { decision: 'completed', submissionId: job.id }
        if (job.status !== 'processing' || job.leaseUntil <= now()) throw boardError(409, 'LEASE_EXPIRED', '处理租约已过期，请重新领取并核对结果')
        if (operation === 'complete') { job.status = 'completed'; job.completedAt = timestamp() }
        if (operation === 'renew') job.leaseUntil = now() + LEASE_MS
        if (operation === 'release') { job.status = 'pending'; job.claimToken = null; job.leaseUntil = null }
        receivers.set(id, now()); await saveJobs(item, list)
        return { decision: operation === 'complete' ? 'completed' : operation, submissionId: job.id, leaseUntil: job.leaseUntil }
      })
    },
    async previewTrash(id) {
      return exclusive(async () => {
        const item = await record(id)
        return { board: publicBoard(item.board), bytes: await bytesIn(item.canvasDir), protectedReasons: await protection(item), revision: item.board.revision }
      })
    },
    async trash(id, revision) {
      return exclusive(async () => {
        const item = await record(id)
        if (item.board.revision !== revision) throw boardError(409, 'BOARD_CHANGED', '画板已变化，请重新预览')
        const reasons = await protection(item)
        if (reasons.length) throw boardError(409, 'BOARD_IN_USE', reasons.join('；'))
        const parent = join(item.project.canvasDir, 'board-trash')
        await mkdir(parent, { recursive: true }); await safeDirectory(parent, item.project.canvasDir)
        const destination = join(parent, id)
        // Same-volume reversible move. Journal allows recovery if index write fails.
        await writeJsonAtomic(join(item.canvasDir, 'recycle-manifest.json'), { board: item.board, deletedAt: timestamp(), originalPath: item.canvasDir })
        await rename(item.canvasDir, destination)
        item.board.state = 'trashed'; item.board.revision++; item.board.deletedAt = timestamp()
        try { await writeJsonAtomic(indexPath, item.catalog) }
        catch (error) { await rename(destination, item.canvasDir); throw error }
        return publicBoard(item.board)
      })
    },
    async restore(id) {
      return exclusive(async () => {
        const item = await record(id, { allowTrash: true })
        if (item.board.state !== 'trashed') return publicBoard(item.board)
        const parent = join(item.project.canvasDir, 'boards'); await safeDirectory(parent, item.project.canvasDir)
        const destination = join(parent, id)
        try { await lstat(destination); throw boardError(409, 'RESTORE_CONFLICT', '原画板位置已存在，拒绝覆盖') } catch (error) { if (error.code !== 'ENOENT') throw error }
        await rename(item.canvasDir, destination)
        item.board.state = 'archived'; item.board.revision++; delete item.board.deletedAt
        try { await writeJsonAtomic(indexPath, item.catalog) } catch (error) { await rename(destination, item.canvasDir); throw error }
        return publicBoard(item.board)
      })
    },
  }
}
