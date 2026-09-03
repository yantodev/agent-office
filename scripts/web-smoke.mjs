import assert from 'node:assert/strict'
import { createConnection } from 'node:net'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createWebServer } from '../src/web/server.ts'
import { createLocalWorkerRuntime } from '../src/web/worker.ts'
import { migrateDatabase, openDatabase } from '../src/main/database.ts'
import { createSqliteStorage } from '../src/web/storage.ts'

const storage = {
  listProjects: () => [{ id: 'project-1', name: 'Smoke' }],
  updateProject: input => ({ ...input, defaultBranch: 'main', useWorktrees: input.useWorktrees ? 1 : 0 }),
  removeProject: () => true,
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
const recoveryDatabase = openDatabase(staticDir)
migrateDatabase(recoveryDatabase)
recoveryDatabase.prepare('INSERT INTO projects (id, name, path) VALUES (?, ?, ?)').run('recovery-project', 'Recovery', staticDir)
recoveryDatabase.prepare('INSERT INTO agents (id, name, command, cwd, role, project_id, status) VALUES (?, ?, ?, ?, ?, ?, ?)').run('recovery-agent', 'Recovery', 'sh', process.cwd(), 'Test', 'recovery-project', 'working')
const recoveryStorage = createSqliteStorage(recoveryDatabase)
assert.equal(recoveryStorage.recoverInterruptedAgents(), 1)
assert.equal(recoveryStorage.listAgents()[0].status, 'offline')
recoveryDatabase.close()
const app = createWebServer({ storage, token: 'smoke-token', staticDir, nineRouterEnvironment: { AGENT_OFFICE_9ROUTER_ENABLED: '0' } })
const limitedApp = createWebServer({ storage, token: 'smoke-token', rateLimit: { maxRequests: 1, windowMs: 60_000 } })
let staleStatus
const controlStorage = {
  ...storage,
  getAgent: id => id === 'stale-agent' ? { id, name: 'Stale', command: 'sh', cwd: process.cwd(), role: 'Test', projectId: 'project-1' } : null,
  setAgentStatus: (_id, status) => { staleStatus = status },
}
const controlApp = createWebServer({ storage: controlStorage, token: 'smoke-token', worker: createLocalWorkerRuntime() })
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
  await new Promise(resolve => limitedApp.server.listen(0, '127.0.0.1', resolve))
  const limitedAddress = limitedApp.server.address()
  const limitedBase = `http://127.0.0.1:${limitedAddress.port}`
  await new Promise(resolve => controlApp.server.listen(0, '127.0.0.1', resolve))
  const controlAddress = controlApp.server.address()
  const controlResponse = await fetch(`http://127.0.0.1:${controlAddress.port}/v1/agents/stale-agent/control`, { method: 'POST', headers: { authorization: 'Bearer smoke-token', 'content-type': 'application/json' }, body: JSON.stringify({ action: 'interrupt' }) })
  assert.equal(controlResponse.status, 409)
  assert.equal((await controlResponse.json()).status, 'offline')
  assert.equal(staleStatus, 'offline')
  assert.equal((await fetch(`${base}/`)).status, 200)
  assert.match(await (await fetch(`${base}/`)).text(), /Agent Office/)
  assert.equal((await fetch(`${base}/healthz`)).status, 200)
  const routerHealth = await fetch(`${base}/v1/integrations/9router/health`, { headers: { authorization: 'Bearer smoke-token' } })
  assert.equal(routerHealth.status, 200)
  assert.equal((await routerHealth.json()).status, 'disabled')
  const routerConfig = await fetch(`${base}/v1/integrations/9router/config`, { method: 'POST', headers: { authorization: 'Bearer smoke-token', 'content-type': 'application/json' }, body: JSON.stringify({ enabled: false, baseUrl: 'http://127.0.0.1:20128/v1', model: '' }) })
  assert.equal(routerConfig.status, 200)
  const configuredRouter = await routerConfig.json()
  assert.equal(configuredRouter.status, 'disabled')
  assert.equal('apiKey' in configuredRouter, false)
  const directories = await fetch(`${base}/v1/directories?path=${encodeURIComponent(staticDir)}`, { headers: { authorization: 'Bearer smoke-token' } })
  assert.equal(directories.status, 200)
  assert.equal((await directories.json()).path, staticDir)
  const updatedProject = await fetch(`${base}/v1/projects/project-1`, { method: 'PATCH', headers: { authorization: 'Bearer smoke-token', 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Updated', path: staticDir, useWorktrees: false }) })
  assert.equal(updatedProject.status, 200)
  assert.equal((await updatedProject.json()).path, staticDir)
  assert.equal((await fetch(`${base}/v1/projects/project-1`, { method: 'DELETE', headers: { authorization: 'Bearer smoke-token' } })).status, 200)
  assert.equal((await fetch(`${base}/v1/projects`)).status, 401)
  const response = await fetch(`${base}/v1/projects`, { headers: { authorization: 'Bearer smoke-token' } })
  assert.deepEqual(await response.json(), [{ id: 'project-1', name: 'Smoke' }])
  const tasks = await fetch(`${base}/v1/projects/project-1/tasks`, { headers: { authorization: 'Bearer smoke-token' } })
  assert.deepEqual(await tasks.json(), [{ projectId: 'project-1', id: 'task-1' }])
  assert.equal((await fetch(`${base}/v1/cli`, { headers: { authorization: 'Bearer smoke-token' } })).status, 200)
  assert.equal((await fetch(`${limitedBase}/v1/projects`, { headers: { authorization: 'Bearer smoke-token' } })).status, 200)
  const limitedResponse = await fetch(`${limitedBase}/v1/projects`, { headers: { authorization: 'Bearer smoke-token' } })
  assert.equal(limitedResponse.status, 429)
  assert.equal(limitedResponse.headers.get('retry-after'), '60')
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
  await new Promise(resolve => {
    limitedApp.server.closeAllConnections?.()
    limitedApp.server.closeIdleConnections?.()
    limitedApp.server.close(() => resolve())
  })
  await new Promise(resolve => {
    controlApp.server.closeAllConnections?.()
    controlApp.server.closeIdleConnections?.()
    controlApp.server.close(() => resolve())
  })
  await rm(staticDir, { recursive: true, force: true })
}
