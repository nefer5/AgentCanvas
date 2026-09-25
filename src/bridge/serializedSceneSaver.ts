import type { SceneSnapshot } from './types'

type SaveScene = (
  projectId: string,
  scene: SceneSnapshot,
  baseRevision: number,
) => Promise<{ revision: number }>

export class SerializedSceneSaver {
  private activeFlush: Promise<void> | null = null
  private diskPaused = false
  private latestScene: SceneSnapshot | null = null
  private latestGeneration = 0
  private persistedGeneration = 0
  private sceneRevision = 0
  private activeProjectId: string | null = null

  constructor(private readonly saveScene: SaveScene) {}

  get projectId(): string | null {
    return this.activeProjectId
  }

  get scene(): SceneSnapshot | null {
    return this.latestScene
  }

  get generation(): number {
    return this.latestGeneration
  }

  get savedGeneration(): number {
    return this.persistedGeneration
  }

  get revision(): number {
    return this.sceneRevision
  }

  get paused(): boolean {
    return this.diskPaused
  }

  configure(projectId: string, revision: number, scene: SceneSnapshot | null): void {
    if (this.activeFlush) {
      throw new Error('Cannot switch projects while a scene save is active')
    }
    this.activeProjectId = projectId
    this.latestScene = scene
    this.sceneRevision = revision
    this.latestGeneration = 0
    this.persistedGeneration = 0
    this.diskPaused = false
  }

  update(scene: SceneSnapshot): number {
    if (!this.activeProjectId) {
      throw new Error('Cannot update a scene before configuring its project')
    }
    this.latestScene = scene
    this.latestGeneration += 1
    return this.latestGeneration
  }

  pause(): void {
    this.diskPaused = true
  }

  flush(): Promise<void> {
    if (this.diskPaused
      || !this.activeProjectId
      || !this.latestScene
      || this.latestGeneration <= this.persistedGeneration) {
      return Promise.resolve()
    }
    if (this.activeFlush) return this.activeFlush

    const run = async () => {
      while (!this.diskPaused
        && this.activeProjectId
        && this.latestScene
        && this.latestGeneration > this.persistedGeneration) {
        const projectId = this.activeProjectId
        const scene = this.latestScene
        const generation = this.latestGeneration
        const saved = await this.saveScene(projectId, scene, this.sceneRevision)

        this.sceneRevision = saved.revision
        this.persistedGeneration = generation
      }
    }

    const active = run().finally(() => {
      if (this.activeFlush === active) this.activeFlush = null
    })
    this.activeFlush = active
    return active
  }
}
