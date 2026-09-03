const MAX_TERMINAL_BUFFER = 100_000

type TerminalBufferUpdate = {
  id: string
  data?: string
  cleared?: boolean
}

const buffers = new Map<string, string>()
const listeners = new Set<(update: TerminalBufferUpdate) => void>()

function notify(update: TerminalBufferUpdate) {
  listeners.forEach(listener => listener(update))
}

export function appendTerminalBuffer(id: string, data: string) {
  if (!data) return
  const value = `${buffers.get(id) ?? ''}${data}`
  buffers.set(id, value.slice(-MAX_TERMINAL_BUFFER))
  notify({ id, data })
}

export function clearTerminalBuffer(id: string) {
  if (!buffers.has(id)) return
  buffers.delete(id)
  notify({ id, cleared: true })
}

export function getTerminalBuffer(id: string) {
  return buffers.get(id) ?? ''
}

export function hasTerminalBuffer(id: string) {
  return buffers.has(id)
}

export function subscribeTerminalBuffer(listener: (update: TerminalBufferUpdate) => void) {
  listeners.add(listener)
  return () => listeners.delete(listener)
}
