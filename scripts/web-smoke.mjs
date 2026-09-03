import assert from 'node:assert/strict'
import { createConnection } from 'node:net'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createWebServer } from '../src/web/server.ts'
import { createLocalWorkerRuntime } from '../src/web/worker.ts'

const storage = {
  listProjects: () => [{ id: 'project-1', name: 'Smoke' }],
  listTasks: projectId => [{ projectId, id: 'task-1' }],
  listEvents: () => [],
  listMessages: () => [],
  listApprovals: () => [],
  listMemories: () => [],
  resolveApproval: () => true,
  listProfiles: () => [],
  listAgents: () => [],
  getAgent: () => null,
  setAgentStatus: () => undefined,
  fleetSummary: () => null,
}
const staticDir = await mkdtemp(join(tmpdir(), 'agent-office-web-smoke-'))
await writeFile(join(staticDir, 'index.html'), '<!doctype html><title>Agent Office</title>')
const app = createWebServer({ storage, token: 'smoke-token', staticDir })
const worker = createLocalWorkerRuntime()
let webSocketClient
let workerSession

function closeServer() {
  return new Promise(resolve => {
    const forceClose = setTimeout(() => { app.server.unref(); resolve() }, 250)
    app.server.closeAllConnections?.()
    app.server.closeIdleConnections?.()
    app.server.close(() => { clearTimeout(forceClose); resolve() })
  })
}

function openSocket(port, token) {
  return new Promise((resolve, reject) => {
    const socket = createConnection(port, '127.0.0.1')
    let response = ''
    const timer = setTimeout(() => fail(new Error('Timed out waiting for WebSocket handshake')), 2_000)
    const fail = error => { socket.destroy(); reject(error) }
    socket.once('error', error => { clearTimeout(timer); fail(error) })
    socket.once('connect', () => {
      const key = Buffer.from('agent-office-smoke').toString('base64')
      socket.write([
        'GET /v1/ws HTTP/1.1',
        'Host: 127.0.0.1',
        'Connection: Upgrade',
        'Upgrade: websocket',
        `Sec-WebSocket-Key: ${key}`,
        'Sec-WebSocket-Version: 13',
        `Sec-WebSocket-Protocol: agent-office-v1, bearer.${token}`,
        '',
        '',
      ].join('\r\n'))
    })
    socket.on('data', chunk => {
      response += chunk.toString('latin1')
      if (response.includes('\r\n\r\n')) { clearTimeout(timer); resolve({ socket, response }) }
    })
  })
}

try {
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve))
  const address = app.server.address()
  const base = `http://127.0.0.1:${address.port}`
  assert.equal((await fetch(`${base}/`)).status, 200)
  assert.match(await (await fetch(`${base}/`)).text(), /Agent Office/)
  assert.equal((await fetch(`${base}/healthz`)).status, 200)
  assert.equal((await fetch(`${base}/v1/projects`)).status, 401)
  const response = await fetch(`${base}/v1/projects`, { headers: { authorization: 'Bearer smoke-token' } })
  assert.deepEqual(await response.json(), [{ id: 'project-1', name: 'Smoke' }])
  const tasks = await fetch(`${base}/v1/projects/project-1/tasks`, { headers: { authorization: 'Bearer smoke-token' } })
  assert.deepEqual(await tasks.json(), [{ projectId: 'project-1', id: 'task-1' }])
  assert.equal((await fetch(`${base}/v1/cli`, { headers: { authorization: 'Bearer smoke-token' } })).status, 200)
  assert.throws(() => worker.start({
    id: 'missing-cwd-smoke',
    command: 'printf should-not-run',
    cwd: join(staticDir, 'missing-workspace'),
    userDataPath: staticDir,
    permissions: { filesystem: true, network: true, git: true },
  }), /Working directory does not exist/)

  workerSession = worker.start({
    id: 'worker-smoke',
    command: 'printf web-worker-smoke',
    cwd: process.cwd(),
    userDataPath: staticDir,
    permissions: { filesystem: true, network: true, git: true },
  })
  const workerOutput = await new Promise((resolve, reject) => {
    let output = ''
    const timer = setTimeout(() => reject(new Error('Timed out waiting for web worker output')), 5_000)
    workerSession.onData(data => {
      output += data
      if (output.includes('web-worker-smoke')) {
        clearTimeout(timer)
        resolve(output)
      }
    })
  })
  assert.match(workerOutput, /web-worker-smoke/)
  workerSession.stop()
  workerSession = undefined

  const { socket, response: handshake } = await openSocket(address.port, 'smoke-token')
  webSocketClient = socket
  assert.match(handshake, /^HTTP\/1\.1 101 Switching Protocols/)
  const event = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Timed out waiting for WebSocket event')), 1_000)
    socket.once('data', chunk => { clearTimeout(timer); resolve(chunk) })
  })
  app.broadcast({ type: 'terminal.data', agentId: 'agent-1', data: 'hello' })
  const frame = (await event).toString('latin1')
  assert.match(frame, /terminal\.data/)
  socket.end()
  console.log('web API, static hosting, and WebSocket smoke: ok')
} finally {
  workerSession?.stop()
  webSocketClient?.destroy()
  await closeServer()
  await rm(staticDir, { recursive: true, force: true })
}
