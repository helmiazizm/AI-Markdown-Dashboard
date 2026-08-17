import { generationEventTypes, isTerminalGenerationEvent } from '@fieldboard/contracts'
import { describe, expect, it, vi } from 'vitest'
import { followGeneration } from '../src/lib/api.js'

class FakeEventSource {
  static instances: FakeEventSource[] = []
  static readonly CLOSED = 2
  readyState = 0
  onerror: (() => void) | null = null
  closed = false
  readonly listeners = new Map<string, (event: MessageEvent) => void>()

  constructor(public readonly url: string) {
    FakeEventSource.instances.push(this)
  }

  addEventListener(type: string, handler: (event: MessageEvent) => void): void {
    this.listeners.set(type, handler)
  }

  close(): void {
    this.closed = true
  }

  emit(type: string, data: unknown): void {
    this.listeners.get(type)?.({ data: JSON.stringify(data) } as MessageEvent)
  }
}

function withFakeEventSource<T>(run: () => T): T {
  FakeEventSource.instances = []
  const original = globalThis.EventSource
  ;(globalThis as { EventSource: unknown }).EventSource = FakeEventSource
  try {
    return run()
  } finally {
    ;(globalThis as { EventSource: unknown }).EventSource = original
  }
}

describe('generation event subscription', () => {
  // Regression: the client used a hand-maintained list that omitted planning, designing, and
  // reviewing, so every crew stage was dropped and the trail looked like the old single agent.
  it('subscribes to every stage the contract declares', () => {
    withFakeEventSource(() => {
      followGeneration('run-1', () => {}, () => {}, () => {})
      const source = FakeEventSource.instances[0]!
      expect([...source.listeners.keys()].sort()).toEqual([...generationEventTypes].sort())
    })
  })

  it('delivers a crew stage event that the old list would have dropped', () => {
    withFakeEventSource(() => {
      const received: string[] = []
      followGeneration('run-2', (event) => received.push(event.type), () => {}, () => {})
      const source = FakeEventSource.instances[0]!
      for (const type of ['planning', 'designing', 'reviewing'] as const) {
        source.emit(type, { id: 1, type, message: 'stage', createdAt: 'now' })
      }
      expect(received).toEqual(['planning', 'designing', 'reviewing'])
    })
  })

  it('closes the stream only on a terminal stage', () => {
    withFakeEventSource(() => {
      const onTerminal = vi.fn()
      followGeneration('run-3', () => {}, onTerminal, () => {})
      const source = FakeEventSource.instances[0]!
      source.emit('reviewing', { id: 1, type: 'reviewing', message: 'reviewing', createdAt: 'now' })
      expect(source.closed).toBe(false)
      source.emit('completed', { id: 2, type: 'completed', message: 'done', createdAt: 'now' })
      expect(source.closed).toBe(true)
    })
  })

  it('agrees with the contract on which stages are terminal', () => {
    expect(generationEventTypes.filter(isTerminalGenerationEvent)).toEqual(['publication_blocked', 'completed', 'failed'])
  })
})
