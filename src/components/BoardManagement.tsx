import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { InterfaceIcon } from './InterfaceIcon'
import { sanitizeScene, STORAGE_KEY, type SceneSnapshot } from '../persistence'

export interface Board {
  id: string; projectId: string; name: string; conversation: string | null
  state: 'active' | 'archived' | 'trashed'; favorite: boolean; revision: number
  updatedAt: string; projectName?: string; available?: boolean
  bytes?: number | null; protectedReasons?: string[]
  preview?: { type: string; x: number; y: number; width: number; height: number }[]
}
export async function boardRequest<T>(path: string, body?: unknown, method = 'POST'): Promise<T> {
  const response = await fetch(path, {
    method: body === undefined ? 'GET' : method,
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(path.endsWith('/versions') ? 120_000 : 8000), cache: 'no-store',
  })
  const result = await response.json()
  if (!response.ok) throw new Error(result.error?.message ?? `HTTP ${response.status}`)
  return result
}
function size(bytes: number | null | undefined) {
  if (bytes == null) return '占用未知'
  return bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`
}
type Status = { board: Board; epoch: string; receiverOnline: boolean; windows: number; unknownWindows: number; pending: number; processing: number; checkedAt: string; lastSubmission?: { id: string; status: 'pending' | 'processing' | 'completed' } | null }

export function BoardManagement({ board, projectId, windowId, saveState, error, onExport, onRetrySave, onOpen, onRestoreDraft, historyRequest = 0, onBoardRefresh }: {
  historyRequest?: number
  onBoardRefresh?(board: Board): void
  board: Board | null; projectId: string; windowId: string; saveState: string; error: string | null
  onExport(): void; onRetrySave(): Promise<void>; onOpen(id: string): Promise<void>
  onRestoreDraft(scene: SceneSnapshot): void
}) {
  const [service, setService] = useState('检查中')
  const [checked, setChecked] = useState('')
  const [status, setStatus] = useState<Status | null>(null)
  const [diagnostic, setDiagnostic] = useState('')
  const [history, setHistory] = useState(false)
  useEffect(() => {
    if (historyRequest > 0) { setScope('all'); setFilter('all'); setPage(0); setHistory(true) }
  }, [historyRequest])
  const [boards, setBoards] = useState<Board[]>([])
  const [total, setTotal] = useState(0)
  const [query, setQuery] = useState('')
  const [scope, setScope] = useState('project')
  const [filter, setFilter] = useState('active')
  const [page, setPage] = useState(0)
  const [actionError, setActionError] = useState('')
  const [working, setWorking] = useState(false)
  const [versionResult, setVersionResult] = useState('')
  const [drafts, setDrafts] = useState<{ key: string; title: string }[]>([])
  const failures = useRef(0)
  const epoch = useRef('')
  const polling = useRef(false)
  const dialog = useRef<HTMLDialogElement>(null)
  const check = useCallback(async () => {
    if (polling.current) return
    polling.current = true
    try {
      const health = await boardRequest<{ protocol: number; epoch: string }>('/api/status')
      if (health.protocol !== 2) throw new Error('服务协议不兼容，请使用正式启动器更新服务')
      failures.current = 0; setService('正常'); setChecked(new Date().toLocaleTimeString())
      if (epoch.current && epoch.current !== health.epoch) setDiagnostic('服务已重启；后续保存仍会校验画板版本，冲突时请保留副本。')
      epoch.current = health.epoch
      if (board) {
        try {
        await boardRequest(`/api/boards/${board.id}/presence`, { windowId, visible: document.visibilityState === 'visible', launchId: new URLSearchParams(location.search).get('launch') })
        const nextStatus = await boardRequest<Status>(`/api/boards/${board.id}/status`)
        setStatus(nextStatus)
        onBoardRefresh?.(nextStatus.board)
        } catch (e) { setStatus(null); setDiagnostic(`服务可达，画板状态读取失败：${e instanceof Error ? e.message : String(e)}`) }
      }
    } catch (e) {
      failures.current++; setService(failures.current > 1 ? '暂时不可达' : '连接不稳定')
      setStatus(null); setDiagnostic(String(e instanceof Error ? e.message : e))
    } finally { polling.current = false }
  }, [board?.id, windowId, onBoardRefresh])
  useEffect(() => {
    void check()
    const timer = setInterval(() => { if (document.visibilityState === 'visible') void check() }, 5000)
    const visible = () => { if (document.visibilityState === 'visible') void check(); else setService('后台 · 状态待刷新') }
    document.addEventListener('visibilitychange', visible)
    const leave = () => {
      if (board) navigator.sendBeacon(`/api/boards/${board.id}/presence`, new Blob([JSON.stringify({ windowId, leave: true })], { type: 'application/json' }))
    }
    window.addEventListener('pagehide', leave)
    return () => { clearInterval(timer); document.removeEventListener('visibilitychange', visible); window.removeEventListener('pagehide', leave); leave() }
  }, [check, board?.id, windowId])
  const refreshHistory = useCallback(async () => {
    const params = new URLSearchParams({ state: filter, q: query, offset: String(page * 12), limit: '12' })
    if (scope === 'project') params.set('projectId', projectId)
    const result = await boardRequest<{ boards: Board[]; total: number }>(`/api/boards?${params}`)
    setBoards(result.boards); setTotal(result.total)
  }, [filter, query, page, scope, projectId])
  useEffect(() => { if (history) { dialog.current?.showModal(); void refreshHistory().catch(e => setActionError(e.message)) } }, [history, refreshHistory])
  const act = async (fn: () => Promise<void>) => {
    setWorking(true); setActionError('')
    try { await fn(); await refreshHistory() } catch (e) { setActionError(e instanceof Error ? e.message : String(e)) }
    finally { setWorking(false) }
  }
  const create = () => act(async () => {
    const name = window.prompt('新画板名称', '新画板')
    if (!name?.trim()) return
    const result = await boardRequest<{ board: Board }>('/api/boards', { projectId, name })
    await onOpen(result.board.id)
  })
  const trash = (item: Board) => act(async () => {
    const preview = await boardRequest<{ revision: number; bytes: number; protectedReasons: string[] }>(`/api/boards/${item.id}/trash-preview`)
    if (preview.protectedReasons.length) throw new Error(preview.protectedReasons.join('；'))
    if (!window.confirm(`将“${item.name}”移入回收站？\n占用 ${size(preview.bytes)}，可以恢复。此操作不永久释放磁盘空间。`)) return
    await boardRequest(`/api/boards/${item.id}/trash`, { revision: preview.revision })
  })
  const tidyVersions = async () => {
    setWorking(true); setVersionResult('正在统计版本，请稍候…')
    try {
      const endpoint = board ? `/api/boards/${board.id}/versions` : `/api/projects/${projectId}/versions`
      const plan = await boardRequest<{ totalVersions: number; totalBytes: number; snapshots: { history: number; conflicts: number; bytes: number }; policy: { historySlots: number; historyBytes: number; intervalMs: number; conflictSlots: number } }>(endpoint)
      setVersionResult(`自动历史 ${plan.snapshots.history}/${plan.policy.historySlots} 份，历史容量上限 ${size(plan.policy.historyBytes)}，间隔至少 ${plan.policy.intervalMs / 1000} 秒；冲突副本 ${plan.snapshots.conflicts}/${plan.policy.conflictSlots} 份。快照当前占用 ${size(plan.snapshots.bytes)}。旧格式文件 ${plan.totalVersions} 个，${size(plan.totalBytes)}。当前内容独立保存，不受历史份数限制。`)

    } catch (e) { setVersionResult(e instanceof Error ? e.message : String(e)) }
    finally { setWorking(false) }
  }
  const selected = boards
  const inspectDrafts = () => {
    try {
      const prefix = `${STORAGE_KEY}:${board?.id ?? projectId}:window:`
      setDrafts(Object.keys(localStorage).filter(key => key.startsWith(prefix) && !key.endsWith(':meta') && !key.endsWith(windowId)).map(key => {
        let title = `窗口 ${key.slice(-8)}`
        try { const meta = JSON.parse(localStorage.getItem(`${key}:meta`) ?? '{}'); if (meta.updatedAt) title += ` · ${new Date(meta.updatedAt).toLocaleString()}` } catch { /* Retain accessible draft even without metadata. */ }
        return { key, title }
      }))
    } catch (e) { setDiagnostic(`无法读取浏览器草稿：${String(e)}`) }
  }
  return <section className="board-management" aria-label="画板管理">
    <div className="board-management__summary"><span className={`save-indicator ${saveState.includes('已保存') ? 'is-saved' : 'is-pending'}`}><i aria-hidden="true" />{saveState}</span><button onClick={() => setHistory(true)}><InterfaceIcon name="history" />画板历史</button></div>
    <details className="reliability-panel">
      <summary><span className="reliability-title"><InterfaceIcon name="shield" />连接与可靠性</span> <span className={service === '正常' && !error ? 'status-ok' : 'status-warn'}>{error ? '需处理' : service}</span></summary>
      <dl>
        <dt>本地服务</dt><dd>{service}{checked && ` · ${checked} 确认`}</dd>
        <dt>接收通道</dt><dd>{board ? status ? status.receiverOnline ? '当前聊天可接收' : '离线 · 保留给原画板' : '状态未知' : '旧版项目通道'}</dd>
        <dt>画板保存</dt><dd>{saveState}</dd>
        {status && <><dt>待处理</dt><dd>{status.pending} 条待接收 · {status.processing} 条处理中</dd><dt>编辑窗口</dt><dd>{status.windows} 个活跃 · {status.unknownWindows} 个状态待确认</dd></>}
        {status?.lastSubmission && <><dt>最近提交</dt><dd>{({ pending: '等待接收', processing: '已领取 · 处理租约中', completed: '已确认完成' })[status.lastSubmission.status]}</dd></>}
      </dl>
      <div className="board-actions"><button onClick={() => void check()}>重新检查</button><button onClick={() => void onRetrySave().catch(e => setDiagnostic(e.message))}>重试保存</button><button onClick={onExport}>导出当前副本</button></div>
      <details><summary>自动快照与空间</summary><p>当前内容持续保存；历史按固定份数、容量与时间间隔自动轮换，不再无限累积。</p><button disabled={working} onClick={() => void tidyVersions()}>查看占用与保留策略</button>{versionResult && <p role="status">{versionResult}</p>}</details>
      <details onToggle={event => { if (event.currentTarget.open) inspectDrafts() }}><summary>浏览器恢复草稿</summary><p>只保留尚未确认保存的窗口副本；恢复不会自动解除版本冲突。</p><button onClick={inspectDrafts}>检查草稿</button>{!drafts.length && <p>没有其他窗口的恢复副本</p>}{drafts.map(draft => <div className="draft-item" key={draft.key}><span>{draft.title}</span><button onClick={() => {
        try { const scene = sanitizeScene(JSON.parse(localStorage.getItem(draft.key) ?? 'null')); if (!scene) throw new Error('草稿内容无效'); if (window.confirm('将这份草稿恢复到当前编辑器？当前内容可通过画板撤销恢复。')) onRestoreDraft(scene) } catch (e) { setDiagnostic(String(e)) }
      }}>恢复到编辑器</button></div>)}</details>
      {service !== '正常' && <p>服务无法连接时请运行本机 AgentCanvas 启动器；不要关闭尚未保存的页面。</p>}
      <details><summary>诊断详情</summary><p>{diagnostic || '没有记录到异常'}</p><p>画板：{board?.id ?? '旧版项目画板'}<br/>接收模式：CLI 短轮询；不会自动唤醒已结束的聊天。</p></details>
    </details>
    {error && <p className="board-alert" role="status">{error}</p>}
    {history && createPortal(<dialog ref={dialog} className="board-history" onCancel={() => setHistory(false)} onClose={() => setHistory(false)}>
      <header><div><span className="history-eyebrow">LOCAL LIBRARY</span><h2><InterfaceIcon name="history" />画板历史</h2><p>独立画板与聊天绑定 · 所有数据保留在本机</p></div><button aria-label="关闭画板历史" onClick={() => { dialog.current?.close(); setHistory(false) }}>关闭</button></header>
      <div className="history-toolbar">
        <input aria-label="搜索画板" placeholder="搜索名称、项目或聊天" value={query} onChange={e => { setQuery(e.target.value); setPage(0) }} />
        <select aria-label="项目范围" value={scope} onChange={e => { setScope(e.target.value); setPage(0) }}><option value="project">当前项目</option><option value="all">全部项目</option></select>
        <select aria-label="画板状态" value={filter} onChange={e => { setFilter(e.target.value); setPage(0) }}><option value="active">活跃画板</option><option value="archived">已归档</option><option value="trashed">回收站</option><option value="all">全部状态</option></select>
        <button disabled={working} onClick={create}>＋ 新画板</button>
        <button disabled={working} onClick={() => void act(refreshHistory)}>刷新</button>
      </div>
      <p className="history-storage">{total} 张画板 · 本页占用 {size(boards.reduce((sum, item) => sum + (item.bytes ?? 0), 0))} · 回收站可恢复，不自动永久删除</p>
      {actionError && <p className="board-alert" role="alert">{actionError}</p>}
      {!selected.length && <p className="history-empty">暂无匹配画板。旧版项目画布仍保留在原位置；可新建独立画板。</p>}
      <div className="history-grid">{selected.map(item => <article key={item.id} className="history-card">
        {item.preview?.length ? <BoardThumbnail shapes={item.preview} /> : <div className="history-card__art" aria-hidden="true">{item.state === 'trashed' ? '↶' : item.favorite ? '★' : '▧'}<span>{item.state === 'trashed' ? '回收站' : item.state === 'archived' ? '已归档' : item.id === board?.id ? '当前画板' : '独立画板'}</span></div>}
        <h3>{item.name}</h3><p>{item.projectName ?? item.projectId}</p><p className="history-chat">{item.conversation ?? '手动画板'}</p><p>{new Date(item.updatedAt).toLocaleString()} · {size(item.bytes)}</p>
        {!!item.protectedReasons?.length && <p className="history-protected">保护：{item.protectedReasons.join('、')}</p>}
        <div className="board-actions">
          {item.state === 'trashed' ? <button disabled={working || !item.available} onClick={() => void act(async () => { await boardRequest(`/api/boards/${item.id}/restore`, {}) })}>恢复画板</button> : <>
            <button disabled={working || !item.available} onClick={() => void act(async () => { await onOpen(item.id) })}>打开</button>
            <button disabled={working || !item.available} onClick={() => void act(async () => { const name = window.prompt('画板名称', item.name); if (name?.trim()) await boardRequest(`/api/boards/${item.id}`, { name }, 'PATCH') })}>改名</button>
            <button disabled={working || !item.available} onClick={() => void act(async () => { await boardRequest(`/api/boards/${item.id}`, { favorite: !item.favorite }, 'PATCH') })}>{item.favorite ? '取消收藏' : '收藏'}</button>
            <button disabled={working || !item.available} onClick={() => void act(async () => { await boardRequest(`/api/boards/${item.id}`, { state: item.state === 'archived' ? 'active' : 'archived' }, 'PATCH') })}>{item.state === 'archived' ? '取消归档' : '归档'}</button>
            <button className="danger" disabled={working || !item.available || !!item.protectedReasons?.length || item.id === board?.id} onClick={() => trash(item)}>移入回收站</button>
            {item.protectedReasons?.some(reason => reason.includes('失联窗口')) && <button disabled={working} onClick={() => void act(async () => { if (window.confirm('确认相关窗口已关闭或草稿已另存？解除失联窗口保护后才能清理，迟到的旧页面将不能保存到已回收画板。')) await boardRequest(`/api/boards/${item.id}/release-windows`, {}) })}>解除失联保护</button>}
          </>}
        </div>
      </article>)}</div>
      <footer><button disabled={page === 0} onClick={() => setPage(page - 1)}>上一页</button><span>第 {page + 1} 页</span><button disabled={(page + 1) * 12 >= total} onClick={() => setPage(page + 1)}>下一页</button></footer>
    </dialog>, document.body)}
  </section>
}

function BoardThumbnail({ shapes }: { shapes: NonNullable<Board['preview']> }) {
  const valid = shapes.filter(s => [s.x, s.y, s.width, s.height].every(Number.isFinite))
  if (!valid.length) return null
  const x = Math.min(...valid.map(s => s.x)); const y = Math.min(...valid.map(s => s.y))
  const w = Math.max(1, Math.max(...valid.map(s => s.x + Math.abs(s.width))) - x)
  const h = Math.max(1, Math.max(...valid.map(s => s.y + Math.abs(s.height))) - y)
  return <svg className="board-thumbnail" viewBox={`${x - 12} ${y - 12} ${w + 24} ${h + 24}`} aria-label="画板图形预览">
    {valid.map((s, i) => s.type === 'ellipse'
      ? <ellipse key={i} cx={s.x + s.width / 2} cy={s.y + s.height / 2} rx={Math.abs(s.width) / 2} ry={Math.abs(s.height) / 2} />
      : s.type === 'line' || s.type === 'arrow' ? <line key={i} x1={s.x} y1={s.y} x2={s.x + s.width} y2={s.y + s.height} />
      : <rect key={i} x={s.x} y={s.y} width={Math.abs(s.width)} height={Math.abs(s.height)} rx={s.type === 'text' ? 0 : 4} />)}
  </svg>
}
