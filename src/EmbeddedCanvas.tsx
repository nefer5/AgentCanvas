import { useEffect, useRef, useState } from 'react'
import { Excalidraw, serializeAsJSON, CaptureUpdateAction, restoreElements } from '@excalidraw/excalidraw'
import type { ExcalidrawImperativeAPI, ExcalidrawInitialDataState } from '@excalidraw/excalidraw/types'
import type { ExcalidrawElement } from '@excalidraw/excalidraw/element/types'
import '@excalidraw/excalidraw/index.css'
import { PartialEraser } from './components/PartialEraser'
import { completeErasedStrokes } from './partialEraser'
import { createToolStyles, drawingDefaults } from './drawingDefaults'
import { loadLibrary, saveLibrary } from './library'
import { SerializedSceneSaver } from './bridge/serializedSceneSaver'
import { applyProposal } from './bridge/applyProposal'
import type { SceneSnapshot } from './persistence'
import './embedded.css'

interface Board {
  boardId: string; sessionId: string; revision: number; scene: SceneSnapshot | null; readOnly?: boolean
  edits?: EditProposal[]
}
interface EditProposal {id:string;summary:string;status:string;baseRevision:number;feedbackDelivery?:string}
interface EditPreview extends Board {proposal:EditProposal}
// The host owns session boards. This mode never calls the standalone project/inbox API.
export default function EmbeddedCanvas() {
  const [board,setBoard]=useState<Board|null>(null),[api,setApi]=useState<ExcalidrawImperativeAPI|null>(null)
  const [error,setError]=useState(''),[status,setStatus]=useState('正在连接会话画板…'),[note,setNote]=useState(''),[busy,setBusy]=useState(false)
  const [edits,setEdits]=useState<EditProposal[]>([]),[preview,setPreview]=useState<EditPreview|null>(null)
  const [rejecting,setRejecting]=useState<string|null>(null),[feedback,setFeedback]=useState('')
  const applying=useRef(false)
  const requestRef=useRef<(action:string,payload?:unknown)=>Promise<any>>(async()=>{throw new Error('未连接')})
  const saver=useRef(new SerializedSceneSaver(async(_id,scene,revision)=>requestRef.current('save',{scene,revision}))).current
  const timer=useRef<ReturnType<typeof setTimeout>|null>(null), styles=useRef(createToolStyles())
  const submitId=useRef<string|null>(null), readonly=useRef(false), ready=useRef(false)
  const key=useRef(''), alive=useRef(true)
  const conflictCopy=useRef<string|null>(null)
  const recovery=()=>{
    if(key.current&&saver.scene&&!readonly.current) {
      try {localStorage.setItem(key.current,JSON.stringify({revision:saver.revision,scene:saver.scene}))}
      catch {setError('浏览器恢复副本写入失败，请导出画板备份')}
    }
  }
  const flush=async()=>{
    if(readonly.current||!ready.current)return
    try {await saver.flush();recovery();if(alive.current)setStatus('画板已保存')}
    catch(e){saver.pause();if(alive.current)setError(String(e instanceof Error?e.message:e))}
  }
  useEffect(()=>{
    alive.current=true
    const params=new URLSearchParams(location.search),origin=params.get('parentOrigin'),channel=params.get('channel')
    if(!origin||!/^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(origin)||window.parent===window||!channel){setError('请从 DSH 会话中的画板按钮打开');return}
    const pending=new Map<string,{resolve:(x:any)=>void;reject:(e:Error)=>void;timer:ReturnType<typeof setTimeout>}>()
    const receive=(event:MessageEvent)=>{
      const m=event.data
      if(event.source!==window.parent||event.origin!==origin||m?.type!=='optdsh-canvas-response'||m.channel!==channel)return
      const p=pending.get(m.id);if(!p)return
      pending.delete(m.id);clearTimeout(p.timer);m.error?p.reject(new Error(m.error)):p.resolve(m.result)
    }
    window.addEventListener('message',receive)
    requestRef.current=(action,payload={})=>new Promise((resolve,reject)=>{
      const id=crypto.randomUUID(), timeout=setTimeout(()=>{pending.delete(id);reject(new Error('DSH连接超时；草稿保留在本机，请重新打开'))},20000)
      pending.set(id,{resolve,reject,timer:timeout})
      window.parent.postMessage({type:'optdsh-canvas-request',channel,id,action,payload},origin)
    })
    requestRef.current('load').then((b:Board)=>{
      if(!alive.current)return
      readonly.current=!!b.readOnly;key.current='optdsh-board-recovery:'+b.boardId
      let scene=b.scene
      if(!b.readOnly){
        const raw=localStorage.getItem(key.current)
        if(raw){try{const local=JSON.parse(raw);if(local.revision===b.revision&&local.scene)scene=local.scene
          else if(JSON.stringify(local.scene)!==JSON.stringify(b.scene)){
            conflictCopy.current=raw;localStorage.setItem(key.current+':conflict:'+Date.now(),raw)
            setError('另有不同版本的本地恢复副本，已另存且未覆盖服务端画板；可导出核对')
          }
        }catch{setError('本地恢复副本无法解析，已加载服务端画板')}}
      }
      saver.configure(b.boardId,b.revision,scene);ready.current=true
      if(!b.readOnly&&scene&&JSON.stringify(scene)!==JSON.stringify(b.scene)){saver.update(scene);timer.current=setTimeout(()=>void flush(),750)}
      setBoard({...b,scene});setEdits(b.edits||[]);setStatus(b.readOnly?'历史快照 · 只读':'已绑定当前 DSH 会话')
    }).catch(e=>{if(alive.current)setError(e.message)})
    return()=>{alive.current=false;ready.current=false;window.removeEventListener('message',receive);if(timer.current)clearTimeout(timer.current)
      for(const p of pending.values()){clearTimeout(p.timer);p.reject(new Error('画板已关闭'))}pending.clear()}
  },[saver])
  useEffect(()=>{
    if(!board||board.readOnly)return
    let cancelled=false
    const poll=()=>requestRef.current('status').then((b:Board)=>{if(!cancelled)setEdits(b.edits||[])}).catch(()=>{})
    const timer=setInterval(()=>void poll(),2500)
    return()=>{cancelled=true;clearInterval(timer)}
  },[board?.boardId,board?.readOnly])
  useEffect(()=>{const warn=(e:BeforeUnloadEvent)=>{if(saver.paused){e.preventDefault();e.returnValue=''}};window.addEventListener('beforeunload',warn);return()=>window.removeEventListener('beforeunload',warn)},[saver])
  async function submit(){
    if(!api||busy||readonly.current)return
    setBusy(true);setError('')
    try {
      await flush();if(saver.paused)throw new Error('请先处理保存错误，再提交')
      submitId.current??=crypto.randomUUID()
      const result=await requestRef.current('submit',{revision:saver.revision,note,clientSubmissionId:submitId.current})
      setStatus(result.status==='uncertain'?'交付状态待核对；不会自动重发':'已提交到绑定会话；处理状态见上方记录')
      if(result.status!=='uncertain')submitId.current=null
    }catch(e){setError(String(e instanceof Error?e.message:e))}finally{setBusy(false)}
  }
  function downloadRecovery(){
    const raw=conflictCopy.current||localStorage.getItem(key.current)||JSON.stringify(saver.scene)
    const url=URL.createObjectURL(new Blob([raw],{type:'application/json'})),a=document.createElement('a')
    a.href=url;a.download=(board?.boardId||'canvas')+'-recovery.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000)
  }
  async function previewEdit(proposalId:string){
    if(busy||readonly.current)return
    setBusy(true);setError('')
    try{await flush();if(saver.paused)throw new Error('请先处理画板保存冲突')
      const p=await requestRef.current('preview_edit',{proposalId}) as EditPreview;setPreview(p)
    }catch(e){setError(e instanceof Error?e.message:String(e))}finally{setBusy(false)}
  }
  async function applyEdit(){
    if(!preview||!api||busy||readonly.current)return
    setBusy(true);setError('')
    try{
      const result=await applyProposal<Board>(preview.proposal.id,{flush,paused:()=>saver.paused,revision:()=>saver.revision,
        request:payload=>requestRef.current('apply_edit',payload),install:result=>{
          if(!result.scene)throw new Error('应用后缺少画板内容')
          applying.current=true
          try {
            saver.configure(result.boardId,result.revision,result.scene);recovery()
            api.updateScene({elements:restoreElements(result.scene.elements as ExcalidrawElement[],api.getSceneElements(),{refreshDimensions:true}),captureUpdate:CaptureUpdateAction.IMMEDIATELY})
          }finally{queueMicrotask(()=>{applying.current=false})}
        }})
      setPreview(null);setEdits(result.edits||[]);setStatus('Agent建议已应用；可用画板撤销按钮或Ctrl+Z撤销')
    }catch(e){setError(e instanceof Error?e.message:String(e))}finally{setBusy(false)}
  }
  async function rejectEdit(proposalId:string){
    if(busy)return
    setBusy(true);setError('')
    try{
      await flush();if(saver.paused)throw new Error('请先处理画板保存冲突')
      const b=await requestRef.current('reject_edit',{proposalId,feedback:feedback.trim()}) as Board
      const rejected=b.edits?.find(p=>p.id===proposalId)
      setEdits(b.edits||[]);setPreview(null);setRejecting(null);setFeedback('')
      setStatus(rejected?.feedbackDelivery==='uncertain'?'建议已拒绝；修改意见发送状态待核对，请查看会话':feedback.trim()?'已拒绝并将修改意见发回本会话':'已拒绝建议，原画板未改变')
    }catch(e){setError(e instanceof Error?e.message:String(e))}finally{setBusy(false)}
  }
  const beginReject=(id:string)=>{setRejecting(rejecting===id?null:id);setFeedback('')}
  const rejectForm=(id:string)=>rejecting===id&&<div className="dsh-reject-form">
    <label>修改意见（可选）<textarea autoFocus aria-label="拒绝建议的修改意见" placeholder="例如：把原来的方框往下移动，不要复制；文字跟着方框走。" rows={3} maxLength={4000} value={feedback} disabled={busy} onChange={e=>setFeedback(e.target.value)}/></label>
    <button onClick={()=>void rejectEdit(id)} disabled={busy}>{feedback.trim()?'拒绝并发送修改意见':'确认拒绝'}</button>
    <button onClick={()=>setRejecting(null)} disabled={busy}>取消</button>
  </div>
  if(!board)return <div role="status">{error||status}</div>
  return <main className="dsh-canvas">
    <div className="dsh-canvas-editor"><Excalidraw
      initialData={{...(board.scene as ExcalidrawInitialDataState|null),appState:{...board.scene?.appState,...drawingDefaults},libraryItems:loadLibrary()}}
      excalidrawAPI={setApi} langCode="zh-CN" viewModeEnabled={!!board.readOnly||!!preview||busy}
      onLibraryChange={items=>{try{saveLibrary(items)}catch{setError('图形库保存失败')}}}
      onChange={(elements,appState,files)=>{
        if(!api||readonly.current||!ready.current||applying.current||preview)return
        const completed=completeErasedStrokes(elements)
        if(completed!==elements){api.updateScene({elements:completed,captureUpdate:CaptureUpdateAction.NEVER});return}
        const style=styles.current(appState);if(style)api.updateScene({appState:style})
        const scene=JSON.parse(serializeAsJSON(elements,appState,files,'local')) as SceneSnapshot
        if(JSON.stringify(scene)===JSON.stringify(saver.scene))return
        saver.update(scene);submitId.current=null;recovery();setStatus('草稿已保留，正在保存…')
        if(timer.current)clearTimeout(timer.current);timer.current=setTimeout(()=>void flush(),750)
      }}/>{!board.readOnly&&!preview&&!busy&&<PartialEraser api={api}/>}</div>
    {preview&&<section className="dsh-edit-preview" aria-label="Agent画板建议预览">
      <div className="dsh-edit-toolbar"><strong>Agent建议预览</strong><span>{preview.proposal.summary}</span>
        <button onClick={()=>setPreview(null)} disabled={busy}>返回原画板</button>
        <button onClick={()=>void applyEdit()} disabled={busy||preview.proposal.status!=='proposed'}>应用此修改</button>
        <button onClick={()=>beginReject(preview.proposal.id)} aria-expanded={rejecting===preview.proposal.id} disabled={busy||preview.proposal.status!=='proposed'}>拒绝 ▾</button>
        {error&&<span role="alert">{error}</span>}
        {rejectForm(preview.proposal.id)}
      </div>
      <div className="dsh-edit-scene"><Excalidraw key={preview.proposal.id} initialData={preview.scene as ExcalidrawInitialDataState} viewModeEnabled langCode="zh-CN" excalidrawAPI={p=>{requestAnimationFrame(()=>p.scrollToContent(undefined,{fitToContent:true}))}}/></div>
    </section>}
    {!board.readOnly&&edits.some(p=>p.status==='proposed')&&<div className="dsh-edit-list" aria-label="Agent建议稿">
      {edits.filter(p=>p.status==='proposed').slice(-8).map(p=><div key={p.id}><strong>Agent建议：</strong> {p.summary}
        <button onClick={()=>void previewEdit(p.id)} disabled={busy}>预览修改</button>
        <button onClick={()=>beginReject(p.id)} aria-expanded={rejecting===p.id} disabled={busy}>拒绝 ▾</button>
        {!preview&&rejectForm(p.id)}
      </div>)}
    </div>}
    <div className="dsh-canvas-controls">
      <span title={board.sessionId}>发送目标：{board.sessionId.slice(-8)}</span>
      {!board.readOnly&&<><input aria-label="画板说明" placeholder="给当前聊天的说明" value={note} maxLength={4000} disabled={busy} onChange={e=>{setNote(e.target.value);submitId.current=null}}/>
      <button onClick={()=>void submit()} disabled={busy||saver.paused}>发送到本会话</button></>}
      <span role="status">{status}</span>
      {error&&<span role="alert">{error} <button onClick={downloadRecovery}>导出恢复副本</button></span>}
    </div>
  </main>
}
