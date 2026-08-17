import { describe, expect, it } from 'vitest'
import { parseD3BridgeMessage } from '../src/lib/d3-bridge.js'

describe('D3 iframe bridge', () => {
  it('accepts only the expected source, channel, and message type', () => {
    const frame = window
    const valid = new MessageEvent('message', { source: frame, data: { channel: 'secret', type: 'ready', payload: { height: 300 } } })
    expect(parseD3BridgeMessage(valid, frame, 'secret')?.type).toBe('ready')

    const forgedChannel = new MessageEvent('message', { source: frame, data: { channel: 'forged', type: 'ready' } })
    expect(parseD3BridgeMessage(forgedChannel, frame, 'secret')).toBeNull()
    const forgedType = new MessageEvent('message', { source: frame, data: { channel: 'secret', type: 'navigate' } })
    expect(parseD3BridgeMessage(forgedType, frame, 'secret')).toBeNull()
  })
})
