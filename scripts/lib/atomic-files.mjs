import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { dirname, basename, join } from 'node:path'
import { randomUUID } from 'node:crypto'

const WINDOWS_RENAME_RETRY_DELAYS_MS = [10, 25, 50, 100, 200]
const WINDOWS_TRANSIENT_RENAME_CODES = new Set(['EACCES', 'EBUSY', 'EPERM'])

export async function renameWithRetry(source, destination, {
  renameFile = rename,
  sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  platform = process.platform,
  retryDelays = WINDOWS_RENAME_RETRY_DELAYS_MS,
} = {}) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await renameFile(source, destination)
      return
    } catch (error) {
      if (platform !== 'win32'
        || !WINDOWS_TRANSIENT_RENAME_CODES.has(error?.code)
        || attempt >= retryDelays.length) {
        throw error
      }
      await sleep(retryDelays[attempt])
    }
  }
}

export async function writeFileAtomic(filePath, data, { createParent = true } = {}) {
  if (createParent) await mkdir(dirname(filePath), { recursive: true })
  const tempPath = join(dirname(filePath), `.${basename(filePath)}.${process.pid}.${randomUUID()}.tmp`)
  try {
    await writeFile(tempPath, data)
    await renameWithRetry(tempPath, filePath)
  } catch (error) {
    try {
      await unlink(tempPath)
    } catch (cleanupError) {
      if (cleanupError?.code !== 'ENOENT') {
        throw new AggregateError(
          [error, cleanupError],
          `Atomic write failed and its temp file could not be removed: ${tempPath}`,
        )
      }
    }
    throw error
  }
}

export async function writeJsonAtomic(filePath, value, options) {
  await writeFileAtomic(filePath, `${JSON.stringify(value, null, 2)}\n`, options)
}

export async function readJsonOptional(filePath) {
  try {
    return JSON.parse(await readFile(filePath, 'utf8'))
  } catch (error) {
    if (error && error.code === 'ENOENT') return null
    throw error
  }
}
