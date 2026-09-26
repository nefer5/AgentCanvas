import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { CaptureUpdateAction, Excalidraw } from '@excalidraw/excalidraw'
import type {
  AppState,
  BinaryFiles,
  ExcalidrawImperativeAPI,
  ExcalidrawInitialDataState,
} from '@excalidraw/excalidraw/types'
import type { OrderedExcalidrawElement } from '@excalidraw/excalidraw/element/types'
import '@excalidraw/excalidraw/index.css'
import {
  chooseInitialProject,
  chooseProjectScene,
  clearMatchingDiskError,
  formatSceneConflictMessage,
  hasSceneContent,
  loadProjectAfterFlush,
  nextSubmissionAttempt,
  reconcileSessionSelection,
  type SessionSelection,
  type SubmissionAttempt,
} from './bridge/agentState'
import { BridgeApiError, createBridgeClient } from './bridge/client'
import { exportScene } from './bridge/exportScene'
import { SerializedSceneSaver } from './bridge/serializedSceneSaver'
import type {
  AgentSessionSummary,
  ProjectSummary,
  SceneSnapshot,
} from './bridge/types'
import {
  AgentPanel,
  type PanelSubmissionResult,
} from './components/AgentPanel'
import { loadScene, saveScene } from './persistence'
import { loadLibrary, saveLibrary } from './library'
import { createToolStyles, drawingDefaults } from './drawingDefaults'
import { PartialEraser } from './components/PartialEraser'
import { completeErasedStrokes } from './partialEraser'
import './app.css'

const LOCAL_SAVE_DELAY_MS = 300
const DISK_SAVE_DELAY_MS = 750
const SESSION_POLL_INTERVAL_MS = 2_000
const LAST_PROJECT_KEY = 'excalidraw-local-last-project-v1'
const SCRATCH_COPY_PROMPT = '新项目还没有画布。要把当前临时画板复制过去吗？'

function messageFrom(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function conflictRecoveryPath(error: BridgeApiError): string | null {
  if (!error.details || typeof error.details !== 'object') return null
  const path = (error.details as { recoveryPath?: unknown }).recoveryPath
  return typeof path === 'string' ? path : null
}

function captureScene(
  elements: readonly OrderedExcalidrawElement[],
  appState: AppState,
  files: BinaryFiles,
): SceneSnapshot {
  return {
    type: 'excalidraw',
    version: 2,
    source: window.location.origin,
    elements: [...elements],
    appState: {
      viewBackgroundColor: appState.viewBackgroundColor,
      theme: appState.theme,
      gridSize: appState.gridSize,
      gridStep: appState.gridStep,
      gridModeEnabled: appState.gridModeEnabled,
      currentItemRoughness: appState.currentItemRoughness,
    },
    files: files as unknown as Record<string, unknown>,
  }
}

export default function App() {
  const client = useMemo(() => createBridgeClient(), [])
  const saverRef = useRef<SerializedSceneSaver | null>(null)
  if (!saverRef.current) {
    saverRef.current = new SerializedSceneSaver((projectId, scene, baseRevision) => (
      client.saveScene(projectId, scene, baseRevision)
    ))
  }
  const saver = saverRef.current

  const [projects, setProjects] = useState<ProjectSummary[]>([])
  const [currentProjectId, setCurrentProjectId] = useState('')
  const [initialScene, setInitialScene] = useState<SceneSnapshot | null>(null)
  const [sessions, setSessions] = useState<AgentSessionSummary[]>([])
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null)
  const [note, setNote] = useState('')
  const [canvasEmpty, setCanvasEmpty] = useState(true)
  const [lastResult, setLastResult] = useState<PanelSubmissionResult | null>(null)
  const [appError, setAppError] = useState<string | null>(null)
  const [conflictNotice, setConflictNotice] = useState<string | null>(null)
  const [sessionError, setSessionError] = useState<string | null>(null)
  const [booting, setBooting] = useState(true)
  const [switching, setSwitching] = useState(false)
  const [submitting, setSubmitting] = useState(false)

  const apiRef = useRef<ExcalidrawImperativeAPI | null>(null)
  const [canvasApi, setCanvasApi] = useState<ExcalidrawImperativeAPI | null>(null)
  const toolStylesRef = useRef(createToolStyles())
  const localTimerRef = useRef<ReturnType<typeof window.setTimeout> | null>(null)
  const diskTimerRef = useRef<ReturnType<typeof window.setTimeout> | null>(null)
  const submissionAttemptRef = useRef<SubmissionAttempt | null>(null)
  const selectedSessionRef = useRef<SessionSelection>({ id: null, source: null })
  const sessionsRef = useRef<AgentSessionSummary[]>([])
  const noteRef = useRef('')
  const switchingRef = useRef(false)
  const submittingRef = useRef(false)
  const conflictErrorRef = useRef<BridgeApiError | null>(null)
  const conflictVersionRef = useRef(0)
  const diskErrorRef = useRef<string | null>(null)
  const sessionProjectRef = useRef('')
  const scratchCopyPromptedRef = useRef(new Set<string>())

  const currentProject = projects.find((project) => project.id === currentProjectId) ?? null

  const flushLocalSave = useCallback(() => {
    if (localTimerRef.current) {
      window.clearTimeout(localTimerRef.current)
      localTimerRef.current = null
    }
    if (!saver.projectId || !saver.scene) return
    try {
      saveScene(window.localStorage, saver.projectId, saver.scene)
    } catch (error) {
      setAppError(`浏览器恢复副本保存失败：${messageFrom(error)}`)
    }
  }, [saver])

  const flushDiskSave = useCallback(async ({
    allowPausedForSwitch = false,
  }: { allowPausedForSwitch?: boolean } = {}) => {
    if (diskTimerRef.current) {
      window.clearTimeout(diskTimerRef.current)
      diskTimerRef.current = null
    }
    if (saver.paused) {
      if (allowPausedForSwitch) return
      const conflict = conflictErrorRef.current
      if (conflict) {
        setConflictNotice(formatSceneConflictMessage(conflictRecoveryPath(conflict)))
        throw conflict
      }
      const error = new Error('画布磁盘自动保存已因版本冲突暂停')
      setConflictNotice(formatSceneConflictMessage(null))
      throw error
    }

    try {
      await saver.flush()
      const resolvedDiskError = diskErrorRef.current
      if (resolvedDiskError !== null) {
        diskErrorRef.current = null
        setAppError((current) => clearMatchingDiskError(current, resolvedDiskError))
      }
    } catch (error) {
      if (error instanceof BridgeApiError && error.code === 'SCENE_CONFLICT') {
        flushLocalSave()
        saver.pause()
        conflictErrorRef.current = error
        conflictVersionRef.current += 1
        setConflictNotice(formatSceneConflictMessage(conflictRecoveryPath(error)))
      } else {
        const diskError = `画布磁盘保存失败：${messageFrom(error)}`
        diskErrorRef.current = diskError
        setAppError(diskError)
      }
      throw error
    }
  }, [flushLocalSave, saver])

  const scheduleDiskSave = useCallback(() => {
    if (saver.paused) return
    if (diskTimerRef.current) window.clearTimeout(diskTimerRef.current)
    diskTimerRef.current = window.setTimeout(() => {
      diskTimerRef.current = null
      void flushDiskSave().catch(() => undefined)
    }, DISK_SAVE_DELAY_MS)
  }, [flushDiskSave, saver])

  const installProjectScene = useCallback((
    project: ProjectSummary,
    scene: SceneSnapshot | null,
    revision: number,
    needsDiskSave: boolean,
  ) => {
    saver.configure(project.id, revision, scene)
    conflictErrorRef.current = null
    diskErrorRef.current = null
    if (scene && needsDiskSave) {
      saver.update(scene)
      try {
        saveScene(window.localStorage, project.id, scene)
      } catch (error) {
        setAppError(`浏览器恢复副本保存失败：${messageFrom(error)}`)
      }
      scheduleDiskSave()
    }
    setInitialScene(scene)
    toolStylesRef.current = createToolStyles()
    setCanvasEmpty(!hasSceneContent(scene))
    sessionProjectRef.current = project.id
    setCurrentProjectId(project.id)
    window.localStorage.setItem(LAST_PROJECT_KEY, project.id)
  }, [saver, scheduleDiskSave])

  useEffect(() => {
    let cancelled = false

    const boot = async () => {
      try {
        const launchUrl = new URL(window.location.href)
        const projectRoot = launchUrl.searchParams.get('projectRoot')?.trim() || null
        const listedProjects = await client.listProjects()
        const agentProject = projectRoot
          ? await client.registerProjectDirectory(projectRoot)
          : null
        const availableProjects = agentProject
          ? [...listedProjects.filter((candidate) => candidate.id !== agentProject.id), agentProject]
          : listedProjects
        const project = chooseInitialProject(
          availableProjects,
          window.localStorage.getItem(LAST_PROJECT_KEY),
          agentProject?.id ?? null,
        )
        if (!project) throw new Error('本地服务没有返回临时画板')
        if (agentProject) {
          launchUrl.searchParams.delete('projectRoot')
          window.history.replaceState(
            null,
            '',
            `${launchUrl.pathname}${launchUrl.search}${launchUrl.hash}`,
          )
        }
        const document = await client.loadScene(project.id)
        if (cancelled) return
        const local = document.scene ? null : loadScene(window.localStorage, project.id)
        const scene = chooseProjectScene(document.scene, local)

        setProjects(availableProjects)
        installProjectScene(project, scene, document.revision, !document.scene && Boolean(local))
      } catch (error) {
        if (!cancelled) setAppError(`画板启动失败：${messageFrom(error)}`)
      } finally {
        if (!cancelled) setBooting(false)
      }
    }

    void boot()
    return () => {
      cancelled = true
    }
  }, [client, installProjectScene])

  useEffect(() => {
    if (!currentProjectId) return
    let cancelled = false
    let requested = 0
    let applied = 0

    const poll = async () => {
      const requestId = ++requested
      try {
        const nextSessions = await client.listAgentSessions(currentProjectId)
        if (cancelled || sessionProjectRef.current !== currentProjectId || requestId < applied) return
        applied = requestId
        sessionsRef.current = nextSessions
        setSessions(nextSessions)
        const nextSelection = reconcileSessionSelection(
          nextSessions,
          selectedSessionRef.current,
        )
        if (nextSelection.id !== selectedSessionRef.current.id) {
          submissionAttemptRef.current = null
        }
        selectedSessionRef.current = nextSelection
        setSelectedSessionId(nextSelection.id)
        setSessionError(null)
      } catch (error) {
        if (cancelled || sessionProjectRef.current !== currentProjectId || requestId < applied) return
        applied = requestId
        sessionsRef.current = []
        setSessions([])
        setSelectedSessionId(null)
        if (selectedSessionRef.current.id !== null) submissionAttemptRef.current = null
        selectedSessionRef.current = { id: null, source: null }
        setSessionError(`Agent 会话查询失败：${messageFrom(error)}`)
      }
    }

    void poll()
    const interval = window.setInterval(() => void poll(), SESSION_POLL_INTERVAL_MS)
    return () => {
      cancelled = true
      window.clearInterval(interval)
    }
  }, [client, currentProjectId])

  const handleChange = useCallback((
    elements: readonly OrderedExcalidrawElement[],
    appState: AppState,
    files: BinaryFiles,
  ) => {
    if (!saver.projectId) return
    const completed = completeErasedStrokes(elements)
    if (completed !== elements && apiRef.current) {
      apiRef.current.updateScene({ elements: completed, captureUpdate: CaptureUpdateAction.NEVER })
      return
    }
    const toolStyle = toolStylesRef.current(appState)
    if (toolStyle) apiRef.current?.updateScene({ appState: toolStyle })
    const scene = captureScene(elements, appState, files)
    saver.update(scene)
    submissionAttemptRef.current = null
    setCanvasEmpty(!hasSceneContent(scene))

    if (localTimerRef.current) window.clearTimeout(localTimerRef.current)
    localTimerRef.current = window.setTimeout(() => {
      localTimerRef.current = null
      flushLocalSave()
    }, LOCAL_SAVE_DELAY_MS)
    scheduleDiskSave()
  }, [flushLocalSave, saver, scheduleDiskSave])

  const switchProject = useCallback(async (project: ProjectSummary) => {
    if (project.id === saver.projectId || switchingRef.current || !project.available) return
    switchingRef.current = true
    setSwitching(true)
    setAppError(null)
    const conflictVersionAtStart = conflictVersionRef.current

    try {
      const flushCurrentProject = async () => {
        flushLocalSave()
        await flushDiskSave({ allowPausedForSwitch: true })
        flushLocalSave()
      }
      const targetDocument = await loadProjectAfterFlush(
        flushCurrentProject,
        () => client.loadScene(project.id),
      )

      const previousProjectId = saver.projectId
      const previousScene = saver.scene
      const local = targetDocument.scene ? null : loadScene(window.localStorage, project.id)
      let scene = chooseProjectScene(targetDocument.scene, local)
      let needsDiskSave = !targetDocument.scene && Boolean(local)

      if (previousProjectId === 'scratch'
        && hasSceneContent(previousScene)
        && !hasSceneContent(scene)
        && !scratchCopyPromptedRef.current.has(project.id)) {
        scratchCopyPromptedRef.current.add(project.id)
        if (window.confirm(SCRATCH_COPY_PROMPT)) {
          scene = previousScene
          needsDiskSave = true
        }
      }

      sessionsRef.current = []
      setSessions([])
      setSelectedSessionId(null)
      selectedSessionRef.current = { id: null, source: null }
      submissionAttemptRef.current = null
      setLastResult(null)
      setSessionError(null)
      if (conflictVersionRef.current === conflictVersionAtStart) {
        setConflictNotice(null)
      }
      installProjectScene(project, scene, targetDocument.revision, needsDiskSave)
    } catch (error) {
      setAppError((current) => current ?? `项目切换失败：${messageFrom(error)}`)
    } finally {
      switchingRef.current = false
      setSwitching(false)
    }
  }, [client, flushDiskSave, flushLocalSave, installProjectScene, saver])

  const handleProjectChange = useCallback(async (projectId: string) => {
    const project = projects.find((candidate) => candidate.id === projectId)
    if (project) await switchProject(project)
  }, [projects, switchProject])

  const handleAddProject = useCallback(async () => {
    if (switchingRef.current) return
    try {
      const project = await client.selectProjectDirectory()
      if (!project) return
      setProjects((current) => {
        const withoutProject = current.filter((candidate) => candidate.id !== project.id)
        return [...withoutProject, project]
      })
      await switchProject(project)
    } catch (error) {
      setAppError(`添加项目失败：${messageFrom(error)}`)
    }
  }, [client, switchProject])

  const handleRenameProject = useCallback(async () => {
    if (!currentProject || currentProject.isScratch) return
    const nextName = window.prompt('项目名称', currentProject.name)
    if (nextName === null || nextName.trim() === currentProject.name) return
    try {
      const renamed = await client.renameProject(currentProject.id, nextName)
      setProjects((current) => current.map((project) => (
        project.id === renamed.id ? renamed : project
      )))
      setAppError(null)
    } catch (error) {
      setAppError(`项目改名失败：${messageFrom(error)}`)
    }
  }, [client, currentProject])

  const handleSessionChange = useCallback((sessionId: string | null) => {
    selectedSessionRef.current = sessionId
      ? { id: sessionId, source: 'manual' }
      : { id: null, source: null }
    setSelectedSessionId(sessionId)
    submissionAttemptRef.current = null
  }, [])

  const handleNoteChange = useCallback((nextNote: string) => {
    noteRef.current = nextNote
    setNote(nextNote)
    submissionAttemptRef.current = null
  }, [])

  const handleSubmit = useCallback(async () => {
    if (submittingRef.current || switchingRef.current || !saver.projectId) return
    if (sessionsRef.current.length > 1 && !selectedSessionRef.current.id) {
      setAppError('请先选择要发送给的 Agent')
      return
    }
    if (!hasSceneContent(saver.scene)) {
      setAppError('空画布不能发送')
      return
    }
    const api = apiRef.current
    if (!api) {
      setAppError('画板仍在初始化，请稍后重试')
      return
    }

    submittingRef.current = true
    setSubmitting(true)
    setAppError(null)
    const projectId = saver.projectId
    const targetSessionId = selectedSessionRef.current.id
    const submissionNote = noteRef.current

    try {
      flushLocalSave()
      await flushDiskSave()
      const sceneGeneration = saver.generation
      const sceneRevision = saver.revision
      const exported = await exportScene(api)
      const attempt = nextSubmissionAttempt(submissionAttemptRef.current, {
        projectId,
        sceneGeneration,
        note: submissionNote,
        targetSessionId,
      })
      submissionAttemptRef.current = attempt

      const result = await client.submitScene(projectId, {
        ...exported,
        note: submissionNote,
        targetSessionId,
        sceneRevision,
        clientSubmissionId: attempt.clientSubmissionId,
      })
      submissionAttemptRef.current = null
      setLastResult({
        submissionId: result.submissionId,
        status: result.status,
        submittedAt: new Date().toISOString(),
        sceneRevision,
      })
      setAppError(null)
    } catch (error) {
      if (!(error instanceof BridgeApiError && error.code === 'SCENE_CONFLICT')) {
        setAppError((current) => current ?? `发送失败：${messageFrom(error)}。可以重试本次发送。`)
      }
    } finally {
      submittingRef.current = false
      setSubmitting(false)
    }
  }, [client, flushDiskSave, flushLocalSave, saver])

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.ctrlKey
        && event.key === 'Enter'
        && !submittingRef.current
        && !switchingRef.current) {
        event.preventDefault()
        void handleSubmit()
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [handleSubmit])

  useEffect(() => {
    return () => {
      if (localTimerRef.current) window.clearTimeout(localTimerRef.current)
      if (diskTimerRef.current) window.clearTimeout(diskTimerRef.current)
      if (saver.projectId && saver.scene) {
        try {
          saveScene(window.localStorage, saver.projectId, saver.scene)
        } catch {
          // The page is leaving; the active UI can no longer surface this failure.
        }
      }
      void saver.flush().catch(() => undefined)
    }
  }, [saver])

  if (booting) {
    return (
      <main className="app-shell app-shell--loading" aria-label="Excalidraw 本地画板">
        <p role="status">正在加载本地画板…</p>
      </main>
    )
  }

  if (!currentProject) {
    return (
      <main className="app-shell app-shell--loading" aria-label="Excalidraw 本地画板">
        <p role="alert">{appError ?? '无法加载临时画板'}</p>
      </main>
    )
  }

  const busy = switching || submitting

  return (
    <main className="app-shell" aria-label="Excalidraw 本地画板">
      <Excalidraw
        key={currentProject.id}
        initialData={{
          ...(initialScene as ExcalidrawInitialDataState | null),
          appState: { ...initialScene?.appState, ...drawingDefaults },
          libraryItems: loadLibrary(),
        }}
        onLibraryChange={(items) => {
          try { saveLibrary(items) }
          catch { setAppError('图形库保存失败，请导出图形库备份。') }
        }}
        excalidrawAPI={(api) => {
          apiRef.current = api
          setCanvasApi(api)
        }}
        onChange={handleChange}
        langCode="zh-CN"
      />
      <PartialEraser key={currentProject.id} api={canvasApi} />
      <AgentPanel
        projects={projects}
        currentProjectId={currentProject.id}
        sessions={sessions}
        selectedSessionId={selectedSessionId}
        note={note}
        busy={busy}
        canvasEmpty={canvasEmpty}
        lastResult={lastResult}
        error={conflictNotice ?? appError ?? sessionError}
        onProjectChange={handleProjectChange}
        onAddProject={handleAddProject}
        onRenameProject={handleRenameProject}
        onSessionChange={handleSessionChange}
        onNoteChange={handleNoteChange}
        onSubmit={handleSubmit}
      />
    </main>
  )
}
