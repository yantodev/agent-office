import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { createConnection } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const root = process.cwd()
const dataPath = await mkdtemp(join(tmpdir(), 'agent-office-web-dev-'))
const child = spawn(process.execPath, ['--env-file-if-exists=.env', 'scripts/web-dev.mjs'], {
  cwd: root,
  env: { ...process.env, AGENT_OFFICE_WEB_TOKEN: 'web-dev-smoke-token', AGENT_OFFICE_WEB_HOST: '127.0.0.1', AGENT_OFFICE_WEB_PORT: '8787', AGENT_OFFICE_WEB_DATA: dataPath, AGENT_OFFICE_WEB_CLIENT_PORT: '5187' },
  stdio: ['ignore', 'pipe', 'pipe'],
})
let output = ''
child.stdout.on('data', chunk => { output += chunk.toString() })
child.stderr.on('data', chunk => { output += chunk.toString() })

async function stop() {
  if (child.exitCode === null) child.kill('SIGTERM')
  await Promise.race([once(child, 'exit'), new Promise(resolve => setTimeout(resolve, 2_000))])
  await rm(dataPath, { recursive: true, force: true })
}

async function portIsOpen(port) {
  return new Promise(resolve => {
    const socket = createConnection(port, '127.0.0.1')
    socket.once('connect', () => { socket.destroy(); resolve(true) })
    socket.once('error', () => resolve(false))
  })
}

async function waitForPortClosed(port, timeout = 2_000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (!await portIsOpen(port)) return
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  assert.fail(`Port ${port} masih aktif setelah web:dev berhenti`)
}

async function waitFor(url, predicate, timeout = 10_000) {
  const deadline = Date.now() + timeout
  let lastError = 'no response'
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url)
      if (predicate(response)) return response
      lastError = `HTTP ${response.status}`
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error)
    }
    await new Promise(resolve => setTimeout(resolve, 150))
  }
  throw new Error(`Timed out waiting for ${url}: ${lastError}\n${output.slice(-2_000)}`)
}

try {
  await waitFor('http://127.0.0.1:5187/healthz', response => response.status === 200, 120_000)
  const projects = await fetch('http://127.0.0.1:5187/v1/projects', { headers: { authorization: 'Bearer web-dev-smoke-token' } })
  assert.equal(projects.status, 200)
  console.log('web dev startup smoke: ok')
} finally {
  await stop()
  await waitForPortClosed(8787)
  await waitForPortClosed(5187)
}
