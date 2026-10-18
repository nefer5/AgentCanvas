import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { isAbsolute } from 'node:path'
import { getIntegrationInfo } from './lib/integration-info.mjs'

test('installation discovery is a standalone JSON CLI without server or project', () => {
  const cli = new URL('./agent-canvas.mjs', import.meta.url)
  const output = execFileSync(process.execPath, [fileURLToPath(cli), 'integration-info'], { encoding: 'utf8' }).trim()
  assert.equal(output.split('\n').length, 1)
  const info = JSON.parse(output)
  assert.deepEqual(info, getIntegrationInfo())
  assert.equal(info.product, 'AgentCanvas')
  assert.equal(info.packageName, '@nefer5/agent-canvas')
  assert.equal(info.protocol, 1)
  assert.equal(info.embed.dsh, 4)
  for (const key of ['installationRoot', 'serverEntry', 'webRoot']) assert.ok(isAbsolute(info[key]))
  assert.equal(info.healthPath, '/api/health')
})
