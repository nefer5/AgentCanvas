import { cp, mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'

const source = resolve('node_modules/@excalidraw/excalidraw/dist/prod/fonts')
const destination = resolve('public/fonts')

await mkdir(destination, { recursive: true })
await cp(source, destination, { recursive: true, force: true })
console.log(`Copied Excalidraw fonts to ${destination}`)
