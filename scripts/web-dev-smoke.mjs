import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const root = process.cwd()
const dataPath = await mkdtemp(join(tmpdir(), 'agent-office-web-dev-'))
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'
const child = spawn(npm, ['run', 'web:dev'], {
  cwd: root,
  env: { ...process.env, AGENT_OFFICE_WEB_TOKEN: 'web-dev-smoke-token', AGENT_OFFICE_WEB_DATA: dataPath, AGENT_OFFICE_WEB_CLIENT_PORT: '5187' },
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
  await waitFor('http://127.0.0.1:5187/healthz', response => response.status === 200)
  const projects = await fetch('http://127.0.0.1:5187/v1/projects', { headers: { authorization: 'Bearer web-dev-smoke-token' } })
  assert.equal(projects.status, 200)
  console.log('web dev startup smoke: ok')
} finally {
  await stop()
}
