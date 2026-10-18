import{describe,it,expect}from'vitest'
import{embeddedSubmissionAttempt}from'./embeddedState'
describe('嵌入提交身份',()=>{
 it('相同版本与说明经重载仍复用身份，编辑后新建',()=>{const old={revision:3,note:'同一说明',id:'11111111-1111-4111-8111-111111111111'},stored=JSON.stringify(old);expect(embeddedSubmissionAttempt(3,old.note,stored,()=>{throw Error('不应创建新身份')})).toEqual(old);expect(embeddedSubmissionAttempt(4,old.note,stored,()=> 'new').id).toBe('new');expect(embeddedSubmissionAttempt(3,'新说明',stored,()=> 'changed').id).toBe('changed')})
 it('损坏缓存不覆盖配置或采用非法身份',()=>{expect(embeddedSubmissionAttempt(1,'', 'invalid',()=> 'created').id).toBe('created');expect(embeddedSubmissionAttempt(1,'',JSON.stringify({revision:1,note:'',id:'bad'}),()=> 'valid').id).toBe('valid')})
})
