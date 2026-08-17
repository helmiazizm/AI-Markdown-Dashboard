export const d3BridgeMessageTypes = ['boot', 'ready', 'error', 'tooltip', 'interaction'] as const
export type D3BridgeMessageType = typeof d3BridgeMessageTypes[number]

export interface D3BridgeMessage {
  channel: string
  type: D3BridgeMessageType
  payload: unknown
}

export function parseD3BridgeMessage(
  event: MessageEvent,
  frameWindow: Window | null | undefined,
  channel: string,
): D3BridgeMessage | null {
  if (!frameWindow || event.source !== frameWindow) return null
  if (!event.data || typeof event.data !== 'object') return null
  const data = event.data as Record<string, unknown>
  if (data.channel !== channel || typeof data.type !== 'string') return null
  if (!d3BridgeMessageTypes.includes(data.type as D3BridgeMessageType)) return null
  return { channel, type: data.type as D3BridgeMessageType, payload: data.payload }
}
