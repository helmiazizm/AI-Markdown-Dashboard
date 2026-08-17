import { createId } from '../lib/ids.js'
import { runDataWorker } from './data-worker.js'

export interface SummaryLocation {
  dashboardId: string
  datasetId: string
  revisionId: string
  versionId: string
  asOf: string
}

export function asOfDate(value: string): string {
  const date = value.slice(0, 10)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error(`Invalid summary as_of date: ${value}`)
  return date
}

export function summaryObjectPrefix(location: SummaryLocation): string {
  return [
    'summaries',
    `dashboard=${location.dashboardId}`,
    `dataset=${location.datasetId}`,
    `revision=${location.revisionId}`,
    `version=${location.versionId}`,
    `as_of=${asOfDate(location.asOf)}`,
  ].join('/')
}

export async function writeSummary(
  location: Omit<SummaryLocation, 'versionId'> & { versionId?: string },
  columns: string[],
  rows: Record<string, unknown>[],
): Promise<{ objectPrefix: string; versionId: string }> {
  const versionId = location.versionId ?? createId()
  const resolved: SummaryLocation = { ...location, versionId, asOf: asOfDate(location.asOf) }
  const objectPrefix = summaryObjectPrefix(resolved)
  await runDataWorker({
    operation: 'write_summary',
    objectPrefix,
    columns,
    rows,
    partName: `part_${versionId}.parquet`,
  })
  return { objectPrefix, versionId }
}

export async function readSummary(objectPrefix: string): Promise<{ columns: string[]; rows: Record<string, unknown>[] }> {
  if (!objectPrefix.startsWith('summaries/')) throw new Error('Summary location is not a summaries/ prefix')
  return runDataWorker<{ columns: string[]; rows: Record<string, unknown>[] }>({
    operation: 'read_summary',
    objectPrefix,
  })
}
