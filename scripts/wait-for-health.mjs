const url = process.argv[2] || `http://127.0.0.1:${process.env.API_PORT || 3000}/api/health`
const deadline = Date.now() + Number(process.env.SETUP_HEALTH_TIMEOUT_MS || 300_000)

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function ready(body) {
  const rowCount = Number(body?.activeSnapshot?.rowCount ?? 0)
  return Boolean(body?.postgres && body?.warehouse && body?.minio && body?.repository?.readiness === 'ready' && rowCount > 0)
}

for (;;) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(3_000) })
    const body = await response.json()
    if (response.ok && ready(body)) {
      console.log(`API ready at ${url} (${Number(body.activeSnapshot.rowCount).toLocaleString()} catalog rows)`)
      process.exit(0)
    }
    console.log(`Waiting for catalog health at ${url} (status=${body?.status ?? response.status})`)
  } catch (error) {
    console.log(`Waiting for API at ${url} (${error instanceof Error ? error.message : error})`)
  }
  if (Date.now() >= deadline) {
    console.error(`Timed out waiting for a populated warehouse at ${url}`)
    process.exit(1)
  }
  await sleep(2_000)
}
