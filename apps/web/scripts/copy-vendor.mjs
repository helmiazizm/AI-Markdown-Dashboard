import { copyFile, mkdir } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const webRoot = path.resolve(here, '..')
const source = path.resolve(webRoot, '../../node_modules/d3/dist/d3.min.js')
const vendor = path.join(webRoot, 'public/vendor')
await mkdir(vendor, { recursive: true })
await copyFile(source, path.join(vendor, 'd3.min.js'))
