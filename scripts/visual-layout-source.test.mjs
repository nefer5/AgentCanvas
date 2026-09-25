import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

const visualRunnerPath = fileURLToPath(new URL('./visual-layout-check.ps1', import.meta.url))

test('Windows PowerShell 5.1 visual runner source is pure ASCII', async () => {
  const bytes = await readFile(visualRunnerPath)
  const nonAsciiBytes = [...bytes.entries()]
    .filter(([, value]) => value > 0x7f)
    .map(([offset, value]) => ({ offset, value: `0x${value.toString(16)}` }))

  assert.deepEqual(
    nonAsciiBytes,
    [],
    'BOM-less Windows PowerShell 5.1 scripts must not contain non-ASCII bytes',
  )
})
