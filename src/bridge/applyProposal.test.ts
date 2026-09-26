import {describe,it,expect,vi} from 'vitest'
import {applyProposal} from './applyProposal'
describe('Agent proposal application boundary',()=>{
  it('waits for pending human save and sends its latest revision',async()=>{
    let revision=3;const calls:string[]=[]
    await applyProposal('p',{flush:async()=>{await Promise.resolve();revision=4;calls.push('saved')},paused:()=>false,revision:()=>revision,
      request:async p=>{expect(p.revision).toBe(4);calls.push('server');return 'new-scene'},install:()=>{calls.push('editor')}})
    expect(calls).toEqual(['saved','server','editor'])
  })
  it('does not install after stale revision rejection',async()=>{
    const install=vi.fn()
    await expect(applyProposal('p',{flush:async()=>{},paused:()=>false,revision:()=>4,request:async()=>{throw new Error('stale')},install})).rejects.toThrow('stale')
    expect(install).not.toHaveBeenCalled()
  })
  it('does not request application while human save is paused',async()=>{
    const request=vi.fn(),install=vi.fn()
    await expect(applyProposal('p',{flush:async()=>{},paused:()=>true,revision:()=>4,request,install})).rejects.toThrow('保存冲突')
    expect(request).not.toHaveBeenCalled();expect(install).not.toHaveBeenCalled()
  })
})
