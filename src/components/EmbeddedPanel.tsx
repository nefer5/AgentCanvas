import { useRef } from 'react'
import { AgentPanel } from './AgentPanel'
import { ConnectionDetails } from './ConnectionDetails'
import type { SceneSnapshot } from '../persistence'

export interface HostBoard {
  boardId:string; sessionId:string; revision:number; scene:SceneSnapshot|null; readOnly?:boolean
  host?:{name:string; workspaceRoot:string; workspaceName:string}
  submissions?:{id:string;revision:number;note:string;status:string;createdAt?:string}[]
}
export const submissionLabel=(state:string)=>({accepting:'正在交付',queued:'已排队，等待本会话处理',running:'本会话正在处理',answered:'Agent已回答，待确认',processed:'已确认处理',uncertain:'交付待核对，不会自动重发','needs-attention':'需要处理'}[state]||state)
export function EmbeddedPanel({board,scene,revision,note,busy,status,error,connected,onNote,onSubmit,onCheck,onSave,onExport,onExportRecovery,onSnapshot,onComplete}:{
 board:HostBoard;scene:SceneSnapshot|null;revision:number;note:string;busy:boolean;status:string;error:string;connected:boolean
 onNote:(v:string)=>void;onSubmit:()=>void;onCheck:()=>void;onSave:()=>void;onExport:()=>void;onExportRecovery?:()=>void;onSnapshot:(id:string)=>void;onComplete:(id:string)=>void
}){
 const history=useRef<HTMLDetailsElement>(null),rows=board.submissions||[],latest=rows.at(-1),path=board.host?.workspaceRoot||'宿主尚未提供课题路径'
 const elements=scene?.elements.filter(e=>e&&typeof e==='object'&&!(e as {isDeleted?:boolean}).isDeleted).length||0
 return <AgentPanel bound boardName="会话画板" conversation={'DSH · 会话 '+board.sessionId.slice(-8)}
  projects={[{id:board.sessionId,name:board.host?.workspaceName||'当前会话课题',rootPath:path,available:true,isScratch:false}]}
  currentProjectId={board.sessionId} sessions={[]} selectedSessionId={null} note={note} busy={busy} readOnly={board.readOnly}
  canvasEmpty={elements===0} elementCount={elements} revision={revision} lastResult={null} error={error||null}
  connection={{connected,label:connected?'已连接当前 DSH 会话 · 提交后自动回投':'连接待恢复 · 草稿保留，不自动发送'}}
  deliveryLabel={latest?submissionLabel(latest.status):''} browseLabel="本会话提交记录"
  onBrowseBoards={()=>{if(history.current){history.current.open=true;history.current.scrollIntoView({block:'nearest'})}}}
  onProjectChange={()=>{}} onAddProject={()=>{}} onRenameProject={()=>{}} onSessionChange={()=>{}} onNoteChange={onNote} onSubmit={onSubmit}
  management={<section className="board-management" aria-label="画板管理">
   <div className="board-management__summary"><span className={'save-indicator '+(status.includes('已保存')?'is-saved':'is-pending')}><i aria-hidden="true" />{status}</span><button onClick={onExport}>导出副本</button></div>
   <ConnectionDetails service={error?'需处理':connected?'正常':'待恢复'} healthy={connected&&!error} rows={[
    {label:'本地服务',value:connected?'独立AgentCanvas编辑器已连接':'未确认连接'},
    {label:'接收通道',value:'当前DSH官方会话 · 显式提交后自动回投'},
    {label:'画板保存',value:status},
    {label:'待处理',value:`${rows.filter(s=>['accepting','queued'].includes(s.status)).length} 条排队 · ${rows.filter(s=>s.status==='running').length} 条处理中`},
    {label:'最近提交',value:latest?submissionLabel(latest.status):'尚无提交'}
   ]}>
    <div className="board-actions"><button onClick={onCheck}>重新检查</button><button disabled={!!board.readOnly||busy} onClick={onSave}>重试保存</button><button onClick={onExport}>导出当前副本</button></div>
    <details><summary>诊断详情</summary><p>画板：{board.boardId}<br/>会话：{board.sessionId}<br/>课题：{path}</p><p>编辑器连接不表示模型正在运行。历史快照只读；保存草稿不会发送给Agent。</p>{error&&<><p role="alert">{error}</p>{onExportRecovery&&<button onClick={onExportRecovery}>导出恢复副本</button>}</>}</details>
   </ConnectionDetails>
   <details ref={history} className="dsh-submission-history"><summary>本会话提交记录 · {rows.length}</summary>
    {!rows.length&&<p>尚无提交；保存草稿不会增加提交记录。</p>}
    {[...rows].reverse().map(s=><div className="dsh-submission-row" key={s.id}><button onClick={()=>onSnapshot(s.id)}>内容版本 {s.revision}</button><span>{s.note||'画板提交'}</span><small>{submissionLabel(s.status)}</small>{s.status==='answered'&&<button disabled={busy||board.readOnly} onClick={()=>onComplete(s.id)}>确认已处理</button>}</div>)}
   </details>
  </section>}/>
}
