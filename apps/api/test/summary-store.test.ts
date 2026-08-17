import { describe, expect, it } from 'vitest'
import { asOfDate, summaryObjectPrefix } from '../src/data/summary-store.js'
import { warehouseIdentityPrefix } from '../src/data/warehouse.js'

describe('summary location keys', () => {
  it('builds a hive-partitioned summaries/ prefix', () => {
    expect(summaryObjectPrefix({
      dashboardId: '6ab401ee-b2c7-4e55-ad17-a37b0487408e',
      datasetId: 'category-volume',
      revisionId: 'eff64b6b-ad2e-4b0c-8170-4979d93720ee',
      versionId: '11111111-1111-4111-8111-111111111111',
      asOf: '2026-03-19T00:00:00.000Z',
    })).toBe('summaries/dashboard=6ab401ee-b2c7-4e55-ad17-a37b0487408e/dataset=category-volume/revision=eff64b6b-ad2e-4b0c-8170-4979d93720ee/version=11111111-1111-4111-8111-111111111111/as_of=2026-03-19')
  })

  it('rejects an invalid as_of date', () => {
    expect(() => asOfDate('March 19')).toThrow('Invalid summary as_of date')
  })
})

describe('warehouse identity', () => {
  it('does not look like a grain-table object prefix', () => {
    expect(warehouseIdentityPrefix('fff25439-1111-4111-8111-111111111111')).toBe(
      'warehouse:catalog@fff25439-1111-4111-8111-111111111111',
    )
  })
})
