import type { SceneSnapshot } from '../persistence'

export type { SceneSnapshot } from '../persistence'

export interface ProjectSummary {
  id: string
  name: string
  rootPath: string
  available: boolean
  isScratch: boolean
}

export interface AgentSessionSummary {
  id: string
  projectId: string
  label: string
  createdAt: string
  expiresAt: string
}

export interface SceneDocument {
  scene: SceneSnapshot | null
  revision: number
  updatedAt: string | null
}

export interface SceneSubmission {
  scene: SceneSnapshot
  svg: string
  pngDataUrl: string
  note: string
  targetSessionId: string | null
  sceneRevision: number
  clientSubmissionId: string
}

export interface SubmissionResult {
  submissionId: string
  status: 'pending' | 'received'
  scenePath: string
  svgPath: string
  pngPath: string
}

export interface BridgeClient {
  listProjects(): Promise<ProjectSummary[]>
  selectProjectDirectory(): Promise<ProjectSummary | null>
  registerProjectDirectory(rootPath: string): Promise<ProjectSummary>
  renameProject(projectId: string, name: string): Promise<ProjectSummary>
  loadScene(projectId: string): Promise<SceneDocument>
  saveScene(
    projectId: string,
    scene: SceneSnapshot,
    baseRevision: number,
  ): Promise<Omit<SceneDocument, 'scene'>>
  listAgentSessions(projectId: string): Promise<AgentSessionSummary[]>
  submitScene(projectId: string, submission: SceneSubmission): Promise<SubmissionResult>
}
