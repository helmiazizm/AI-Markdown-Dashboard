import { describe, expect, it } from 'vitest'
import { validateDashboardArtifact } from '@fieldboard/contracts'
import { createDemoArtifact } from '../src/agent/demo.js'

describe('deterministic generation adapter artifact', () => {
  it('produces a complete, valid source-agnostic dashboard', () => {
    const artifact = validateDashboardArtifact(createDemoArtifact(
      'Show an overview of the active source',
      1,
      ['fashion.catalog.products', 'tlc.taxi.yellow_trips'],
    ))
    expect(artifact.datasets).toHaveLength(1)
    expect(artifact.datasets[0]?.sql).toContain('fashion.catalog.products')
    expect(artifact.datasets[0]?.sql).toContain('tlc.taxi.yellow_trips')
    expect(artifact.widgets.map((widget) => widget.engine)).toEqual(['echarts'])
  })
})
