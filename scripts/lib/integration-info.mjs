import { createHash } from 'node:crypto'
import { readFileSync, realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'

const installationRoot = fileURLToPath(new URL('../../', import.meta.url))
const metadata = JSON.parse(readFileSync(resolve(installationRoot, 'package.json'), 'utf8'))

// Only installation metadata: no data directory, project discovery or queue claims.
export function getIntegrationInfo() {
  return {
    product: 'AgentCanvas', packageName: metadata.name, version: metadata.version,
    installationRoot: resolve(installationRoot),
    serverEntry: resolve(installationRoot, 'scripts/server.mjs'),
    webRoot: resolve(installationRoot, 'dist'),
    installationId: createHash('sha256').update(realpathSync(installationRoot)).digest('hex').slice(0, 24),
    protocol: 1, embed: { dsh: 4, sidebar: 1 }, healthPath: '/api/health',
  }
}
