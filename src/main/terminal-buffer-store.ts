import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'

const MAX_TERMINAL_OUTPUT = 100_000

function bufferDirectory(root: string) {
  return join(root, 'terminal-buffers')
}

function bufferPath(root: string, agentId: string) {
  const safeId = createHash('sha256').update(agentId).digest('hex')
  return join(bufferDirectory(root), `${safeId}.log`)
}

export function appendTerminalOutput(root: string, agentId: string, data: string) {
  if (!data) return
  const directory = bufferDirectory(root)
  mkdirSync(directory, { recursive: true })
  const target = bufferPath(root, agentId)
  appendFileSync(target, data, 'utf8')
  if (statSync(target).size <= MAX_TERMINAL_OUTPUT) return
  const output = readFileSync(target, 'utf8').slice(-MAX_TERMINAL_OUTPUT)
  writeFileSync(target, output, 'utf8')
}

export function readTerminalOutput(root: string, agentId: string) {
  const target = bufferPath(root, agentId)
  if (!existsSync(target)) return ''
  try { return readFileSync(target, 'utf8') } catch { return '' }
}

export function clearTerminalOutput(root: string, agentId: string) {
  const target = bufferPath(root, agentId)
  try { unlinkSync(target) } catch { /* Buffer sudah tidak ada. */ }
}

export function clearAllTerminalOutputs(root: string) {
  const directory = bufferDirectory(root)
  if (!existsSync(directory)) return
  for (const entry of readdirSync(directory)) {
    try { unlinkSync(join(directory, entry)) } catch { /* File mungkin sudah dibersihkan process lain. */ }
  }
}
