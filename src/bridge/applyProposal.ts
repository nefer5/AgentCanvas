/** Apply only after pending human edits are saved, using their resulting revision. */
export async function applyProposal<T>(proposalId:string, flow:{
  flush:()=>Promise<void>
  paused:()=>boolean
  revision:()=>number
  request:(payload:{proposalId:string;revision:number})=>Promise<T>
  install:(result:T)=>void
}):Promise<T>{
  await flow.flush()
  if(flow.paused())throw new Error('请先处理画板保存冲突')
  const result=await flow.request({proposalId,revision:flow.revision()})
  flow.install(result)
  return result
}
