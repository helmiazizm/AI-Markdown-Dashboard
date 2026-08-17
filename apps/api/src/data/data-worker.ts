import { Worker } from 'node:worker_threads'
import { getConfig } from '../config.js'

export async function runDataWorker<T>(input: Record<string, unknown>, timeoutMs = getConfig().QUERY_TIMEOUT_MS): Promise<T> {
  return new Promise((resolve, reject) => {
    const runningTypeScript = import.meta.url.endsWith('.ts')
    const workerUrl = new URL(runningTypeScript ? './query-worker.ts' : './query-worker.js', import.meta.url)
    const worker = new Worker(workerUrl, {
      workerData: input,
      execArgv: runningTypeScript ? ['--import', 'tsx'] : [],
    })
    let settled = false
    const timeout = setTimeout(() => {
      settled = true
      void worker.terminate()
      reject(new Error(`Query timed out after ${Math.round(timeoutMs / 1000)} seconds`))
    }, timeoutMs)

    worker.once('message', (message: T & { ok: boolean; error?: string }) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      void worker.terminate()
      if (!message.ok) reject(new Error(message.error ?? 'Warehouse worker failed'))
      else resolve(message)
    })
    worker.once('error', (error) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      reject(error)
    })
    worker.once('exit', (code) => {
      if (settled || code === 0) return
      settled = true
      clearTimeout(timeout)
      reject(new Error(`Warehouse worker exited with code ${code}`))
    })
  })
}
