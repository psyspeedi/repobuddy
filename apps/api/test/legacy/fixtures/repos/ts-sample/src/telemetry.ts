export interface TelemetryEvent {
  name: string
  payload: Record<string, unknown>
  timestamp: number
}

export function logEvent(name: string, payload: Record<string, unknown>): void {
  const event: TelemetryEvent = { name, payload, timestamp: Date.now() }
  // In a real system this would emit to a sink.
  void event
}
