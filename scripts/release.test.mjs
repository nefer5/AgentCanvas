import test from 'node:test'
import assert from 'node:assert/strict'
import {releaseEntries,releaseName,assertSafeTarget} from './lib/release.mjs'
test('release payload is explicit and never includes local data or Node',()=>{
  const targets=releaseEntries().map(e=>e.target)
  for(const required of ['app/dist','app/package.json','LICENSE','skills/agent-canvas/SKILL.md','agent-canvas.cmd'])assert.ok(targets.includes(required))
  assert.ok(!targets.some(p=>/node_modules|node\.exe|\.agent-canvas|\.git|artifacts/.test(p)))
})
test('unsafe release paths and invalid versions are rejected',()=>{
  for(const p of ['../secret','.agent-canvas/scene','app/../secret','C:/secret','app/scripts/x.test.mjs'])assert.throws(()=>assertSafeTarget(p))
  for(const v of ['../x','0.1','v1.0.0','1.0.0-beta'])assert.throws(()=>releaseName(v))
  assert.equal(releaseName('0.1.0'),'AgentCanvas-0.1.0-win-x64')
})
