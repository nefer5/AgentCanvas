export interface EmbeddedSubmissionAttempt {revision:number;note:string;id:string}
// 以确认保存的内容版本和说明复用提交身份，重开页面也不重复回投。
export function embeddedSubmissionAttempt(revision:number,note:string,stored:string|null,createId:()=>string):EmbeddedSubmissionAttempt {
 try{const value=JSON.parse(stored||'null');if(value?.revision===revision&&value.note===note&&typeof value.id==='string'&&/^[a-f0-9-]{36}$/.test(value.id))return value}catch{}
 return {revision,note,id:createId()}
}
