import { describe, expect, it } from 'vitest'
import { recordedModel } from '../src/agent/generation-service.js'
import type { AppConfig } from '../src/config.js'

function configFor(mode: AppConfig['AGENT_MODE']): AppConfig {
  return { AGENT_MODE: mode, OPENROUTER_MODEL: 'vendor/model-1' } as AppConfig
}

describe('provenance model recording', () => {
  it('records the real model for every LLM-backed mode', () => {
    expect(recordedModel(configFor('cline'))).toBe('vendor/model-1')
    expect(recordedModel(configFor('crew'))).toBe('vendor/model-1')
  })

  it('records the deterministic marker only for demo mode', () => {
    expect(recordedModel(configFor('demo'))).toBe('deterministic-demo')
  })

  // Guards the defect this test was written for: a new mode added to the enum without updating
  // the recording logic silently attributed real LLM output to the deterministic demo adapter.
  it('never attributes a non-demo mode to the demo adapter', () => {
    const modes: AppConfig['AGENT_MODE'][] = ['demo', 'cline', 'crew']
    for (const mode of modes) {
      if (mode === 'demo') continue
      expect(recordedModel(configFor(mode))).not.toBe('deterministic-demo')
    }
  })
})
