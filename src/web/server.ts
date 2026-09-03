import { createHash, timingSafeEqual } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, normalize, resolve } from 'node:path'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { WebStorage } from './storage.ts'
import type { WorkerRuntime, WorkerSession } from './worker.ts'
import { appendTerminalOutput, clearAllTerminalOutputs, clearTerminalOutput, readTerminalOutput } from '../main/terminal-buffer-store.ts'

type WebServerOptions = {
  storage: WebStorage
  token: string
  maxBodyBytes?: number
  staticDir?: string
  worker?: WorkerRuntime
  userDataPath?: string
  rateLimit?: { maxRequests?: number; windowMs?: number }
}
type WebSocketClient = { socket: import('node:stream').Duplex; projectId?: string }

function json(response: ServerResponse, status: number, payload: unknown) {
  const body = JSON.stringify(payload)
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  response.end(body)
}

function authorizeValue(value: string | undefined, token: string) {
  if (!value?.startsWith('Bearer ')) return false
  const expected = Buffer.from(token)
  const actual = Buffer.from(value.slice(7))
  return expected.length === actual.length && timingSafeEqual(createHash('sha256').update(expected).digest(), createHash('sha256').update(actual).digest())
}

function authorized(request: IncomingMessage, token: string) {
  return authorizeValue(request.headers.authorization, token)
}

function websocketToken(request: IncomingMessage) {
  const protocols = String(request.headers['sec-websocket-protocol'] ?? '').split(',').map(value => value.trim())
  const bearer = protocols.find(value => value.startsWith('bearer.'))
  return bearer?.slice('bearer.'.length)
}

async function body(request: IncomingMessage, maxBytes: number) {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    size += Buffer.byteLength(chunk)
    if (size > maxBytes) throw new Error('Request body is too large')
    chunks.push(Buffer.from(chunk))
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as Record<string, unknown>
}

function frame(payload: unknown) {
  const data = Buffer.from(JSON.stringify(payload))
  if (data.length < 126) return Buffer.concat([Buffer.from([0x81, data.length]), data])
  if (data.length < 65_536) {
    const header = Buffer.alloc(4)
    header[0] = 0x81
    header[1] = 126
    header.writeUInt16BE(data.length, 2)
    return Buffer.concat([header, data])
  }
  const header = Buffer.alloc(10)
  header[0] = 0x81
  header[1] = 127
  header.writeBigUInt64BE(BigInt(data.length), 2)
  return Buffer.concat([header, data])
}

function parseClientFrame(buffer: Buffer) {
  if (buffer.length < 2 || (buffer[0] & 0x0f) !== 1 || !(buffer[1] & 0x80)) return null
  let offset = 2
  let length = buffer[1] & 0x7f
  if (length === 126) {
    if (buffer.length < 4) return null
    length = buffer.readUInt16BE(2)
    offset = 4
  } else if (length === 127) {
    if (buffer.length < 10) return null
    const longLength = buffer.readBigUInt64BE(2)
    if (longLength > BigInt(1_000_000)) return null
    length = Number(longLength)
    offset = 10
  }
  if (buffer.length < offset + 4 + length) return null
  const mask = buffer.subarray(offset, offset + 4)
  const data = buffer.subarray(offset + 4, offset + 4 + length).map((value, index) => value ^ mask[index % 4])
  try { return JSON.parse(Buffer.from(data).toString('utf8')) as Record<string, unknown> } catch { return null }
}

function cors(response: ServerResponse, request: IncomingMessage) {
  const origin = request.headers.origin
  if (origin) {
    response.setHeader('access-control-allow-origin', origin)
    response.setHeader('vary', 'Origin')
  }
  response.setHeader('access-control-allow-headers', 'authorization, content-type')
  response.setHeader('access-control-allow-methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS')
}

function staticFile(response: ServerResponse, request: IncomingMessage, staticDir: string) {
  if (request.method !== 'GET' && request.method !== 'HEAD') return false
  let pathname = '/'
  try { pathname = decodeURIComponent(new URL(request.url ?? '/', 'http://localhost').pathname) } catch { return false }
  const relative = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '')
  const root = resolve(staticDir)
  const filePath = resolve(root, normalize(relative))
  if (!filePath.startsWith(`${root}/`) && filePath !== root) return false
  const candidate = existsSync(filePath) && statSync(filePath).isFile() ? filePath : pathname === '/' ? join(root, 'index.html') : ''
  if (!candidate || !existsSync(candidate)) return false
  const contentTypes: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.woff2': 'font/woff2' }
  const extension = candidate.slice(candidate.lastIndexOf('.')).toLowerCase()
  const data = readFileSync(candidate)
  response.writeHead(200, { 'content-type': contentTypes[extension] ?? 'application/octet-stream', 'cache-control': extension === '.html' ? 'no-cache' : 'public, max-age=31536000, immutable' })
  if (request.method === 'HEAD') response.end()
  else response.end(data)
  return true
}

function listDirectories(requestedPath?: string) {
  const path = resolve(requestedPath || process.cwd())
  if (!existsSync(path) || !statSync(path).isDirectory()) throw new Error(`Directory does not exist: ${path}`)
  const directories = readdirSync(path, { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .sort((left, right) => left.name.localeCompare(right.name))
    .map(entry => ({ name: entry.name, path: join(path, entry.name) }))
  const parentPath = dirname(path) === path ? null : dirname(path)
  return { path, parentPath, directories }
}

export function createWebServer(options: WebServerOptions) {
  const clients = new Set<WebSocketClient>()
  const sessions = new Map<string, WorkerSession>()
  const rateWindows = new Map<string, { startedAt: number; count: number }>()
  const rateLimitMaxRequests = options.rateLimit?.maxRequests ?? 300
  const rateLimitWindowMs = options.rateLimit?.windowMs ?? 60_000
  const terminalOutputRoot = options.userDataPath ?? '.agent-office-web'
  clearAllTerminalOutputs(terminalOutputRoot)

  const broadcast = (event: { projectId?: string; type: string; [key: string]: unknown }) => {
    const payload = frame(event)
    for (const client of clients) {
      if (event.projectId && event.projectId !== client.projectId) continue
      try { client.socket.write(payload) } catch { clients.delete(client) }
    }
  }

  const startWorker = (agentId: string, taskId?: string) => {
    if (!options.worker) throw new Error('Web worker runtime is not configured')
    const liveSession = options.worker.get(agentId)
    if (liveSession) {
      sessions.set(agentId, liveSession)
      if (taskId) throw new Error('Agent already has an active session')
      return true
    }
    sessions.delete(agentId)
    const agent = options.storage.getAgent(agentId)
    if (!agent) throw new Error('Agent not found')
    const profile = agent.profileId ? options.storage.listProfiles().find(value => (value as { id?: string }).id === agent.profileId) as { permissions?: Record<string, boolean> } | undefined : undefined
    const session = options.worker.start({ id: agentId, command: agent.command, cwd: agent.cwd, userDataPath: options.userDataPath ?? '.agent-office-web', permissions: { filesystem: true, network: true, git: true, ...profile?.permissions } })
    sessions.set(agentId, session)
    options.storage.setAgentStatus(agentId, 'working')
    if (agent.projectId) broadcast({ projectId: agent.projectId, type: 'agent.state', agentId, status: 'working' })
    session.onData(data => {
      appendTerminalOutput(terminalOutputRoot, agentId, data)
      broadcast({ projectId: agent.projectId ?? undefined, type: 'terminal.data', agentId, data })
    })
    session.onExit(exitCode => {
      sessions.delete(agentId)
      clearTerminalOutput(terminalOutputRoot, agentId)
      options.storage.setAgentStatus(agentId, exitCode === 0 ? 'idle' : 'error')
      if (agent.projectId) broadcast({ projectId: agent.projectId, type: 'agent.exit', agentId, exitCode })
    })
    if (taskId) options.storage.updateTask({ id: taskId, status: 'running', agentId })
    return true
  }

  const server = createServer(async (request, response) => {
    cors(response, request)
    try {
      const url = new URL(request.url ?? '/', 'http://localhost')
      if (request.method === 'OPTIONS') { response.writeHead(204); response.end(); return }
      if (options.staticDir && staticFile(response, request, options.staticDir)) return
      if (url.pathname === '/healthz' && request.method === 'GET') return json(response, 200, { ok: true })
      if (!authorized(request, options.token)) return json(response, 401, { error: 'Unauthorized' })
      const rateKey = request.socket.remoteAddress || 'unknown'
      const now = Date.now()
      const rate = rateWindows.get(rateKey)
      if (!rate || now - rate.startedAt >= rateLimitWindowMs) rateWindows.set(rateKey, { startedAt: now, count: 1 })
      else if (rate.count >= rateLimitMaxRequests) {
        const retryAfter = Math.max(1, Math.ceil((rate.startedAt + rateLimitWindowMs - now) / 1_000))
        response.setHeader('retry-after', String(retryAfter))
        return json(response, 429, { error: 'Rate limit exceeded', retryAfter })
      }
      else rate.count += 1

      if (url.pathname === '/v1/directories' && request.method === 'GET') {
        return json(response, 200, listDirectories(url.searchParams.get('path') ?? undefined))
      }

      const segments = url.pathname.split('/').filter(Boolean)
      if (url.pathname === '/v1/active-project' && request.method === 'GET') return json(response, 200, options.storage.activeProject())
      if (url.pathname === '/v1/projects' && request.method === 'GET') return json(response, 200, options.storage.listProjects())
      if (url.pathname === '/v1/projects' && request.method === 'POST') return json(response, 201, options.storage.createProject(await body(request, options.maxBodyBytes ?? 1_000_000) as Parameters<WebStorage['createProject']>[0]))
      if (segments[0] === 'v1' && segments[1] === 'projects' && segments.length === 3 && request.method === 'PATCH') return json(response, 200, options.storage.updateProject({ ...(await body(request, options.maxBodyBytes ?? 1_000_000)), id: segments[2] } as Parameters<WebStorage['updateProject']>[0]))
      if (segments[0] === 'v1' && segments[1] === 'projects' && segments.length === 3 && request.method === 'DELETE') {
        const removed = options.storage.removeProject(segments[2])
        return json(response, removed ? 200 : 409, removed ? { ok: true } : { ok: false, error: 'Workspace still has agents' })
      }
      if (segments[0] === 'v1' && segments[1] === 'projects' && segments[3] === 'active' && request.method === 'POST') return json(response, options.storage.setActiveProject(segments[2]) ? 200 : 404, options.storage.activeProject())

      if (segments[0] === 'v1' && segments[1] === 'projects' && segments[2] && segments[3]) {
        const projectId = segments[2]
        const resource = segments[3]
        if (request.method === 'GET') {
          const result = resource === 'tasks' ? options.storage.listTasks(projectId)
            : resource === 'events' ? options.storage.listEvents(projectId)
              : resource === 'messages' ? options.storage.listMessages(projectId)
                : resource === 'approvals' ? options.storage.listApprovals(projectId)
                  : resource === 'memories' ? options.storage.listMemories({ projectId, query: url.searchParams.get('query') ?? undefined })
                    : resource === 'missions' ? options.storage.listMissions(projectId)
                      : resource === 'schedules' ? options.storage.listSchedules(projectId)
                        : resource === 'agents' ? options.storage.listAgents().filter(agent => (agent as { projectId?: string }).projectId === projectId)
                          : undefined
          if (result !== undefined) return json(response, 200, result)
        }
        if (request.method === 'POST') {
          const input = await body(request, options.maxBodyBytes ?? 1_000_000)
          if (resource === 'tasks') return json(response, 201, options.storage.createTask({ ...input, projectId } as Parameters<WebStorage['createTask']>[0]))
          if (resource === 'missions') return json(response, 201, options.storage.createMission({ ...input, projectId } as Parameters<WebStorage['createMission']>[0]))
          if (resource === 'schedules') return json(response, 201, options.storage.createSchedule({ ...input, projectId } as Parameters<WebStorage['createSchedule']>[0]))
          if (resource === 'messages') {
            const message = options.storage.sendMessage({ ...input, projectId } as Parameters<WebStorage['sendMessage']>[0])
            broadcast({ projectId, type: 'message.created', message })
            return json(response, 201, message)
          }
          if (resource === 'memories') return json(response, 201, options.storage.saveMemory({ ...input, projectId } as Parameters<WebStorage['saveMemory']>[0]))
          if (resource === 'agents') return json(response, 201, options.storage.createAgent({ ...input, projectId } as Parameters<WebStorage['createAgent']>[0]))
        }
      }

      if (segments[0] === 'v1' && segments[1] === 'tasks' && segments[2]) {
        const id = segments[2]
        if (request.method === 'PATCH') return json(response, 200, options.storage.updateTask({ ...await body(request, options.maxBodyBytes ?? 1_000_000), id } as Parameters<WebStorage['updateTask']>[0]))
        if (request.method === 'POST' && segments[3] === 'artifacts') return json(response, 201, options.storage.addTaskArtifact({ ...await body(request, options.maxBodyBytes ?? 1_000_000), taskId: id } as Parameters<WebStorage['addTaskArtifact']>[0]))
        if (request.method === 'POST' && segments[3] === 'review') return json(response, 200, options.storage.setTaskReview({ ...await body(request, options.maxBodyBytes ?? 1_000_000), taskId: id } as Parameters<WebStorage['setTaskReview']>[0]))
      }
      if (segments[0] === 'v1' && segments[1] === 'schedules' && segments[2]) {
        if (request.method === 'PATCH') return json(response, 200, options.storage.updateSchedule({ ...await body(request, options.maxBodyBytes ?? 1_000_000), id: segments[2] } as Parameters<WebStorage['updateSchedule']>[0]))
        if (request.method === 'DELETE') return json(response, options.storage.removeSchedule(segments[2]) ? 200 : 404, { ok: true })
      }
      if (segments[0] === 'v1' && segments[1] === 'approvals' && segments[2] && segments[3] === 'resolve' && request.method === 'POST') {
        const input = await body(request, options.maxBodyBytes ?? 1_000_000)
        const status = input.status === 'approved' || input.status === 'rejected' ? input.status : undefined
        if (!status || !options.storage.resolveApproval(segments[2], status)) return json(response, 409, { error: 'Approval is invalid or already resolved' })
        return json(response, 200, { ok: true })
      }
      if (segments[0] === 'v1' && segments[1] === 'messages' && segments[2] && segments[3] === 'ack' && request.method === 'POST') return json(response, 200, { ok: options.storage.acknowledgeMessage({ ...(await body(request, options.maxBodyBytes ?? 1_000_000)), messageId: segments[2] } as Parameters<WebStorage['acknowledgeMessage']>[0]) })
      if (segments[0] === 'v1' && segments[1] === 'memories' && segments[2]) {
        if (request.method === 'PATCH') return json(response, 200, { ok: options.storage.pinMemory({ id: segments[2], pinned: Boolean((await body(request, options.maxBodyBytes ?? 1_000_000)).pinned) }) })
        if (request.method === 'DELETE') return json(response, options.storage.removeMemory(segments[2]) ? 200 : 404, { ok: true })
      }
      if (segments[0] === 'v1' && segments[1] === 'profiles') {
        if (request.method === 'GET' && segments.length === 2) return json(response, 200, options.storage.listProfiles())
        if (request.method === 'POST' && segments.length === 2) return json(response, 201, options.storage.createProfile(await body(request, options.maxBodyBytes ?? 1_000_000) as Parameters<WebStorage['createProfile']>[0]))
        if (request.method === 'PATCH' && segments[2]) return json(response, 200, options.storage.updateProfile({ ...(await body(request, options.maxBodyBytes ?? 1_000_000)), id: segments[2] } as Parameters<WebStorage['updateProfile']>[0]))
        if (request.method === 'DELETE' && segments[2]) return json(response, options.storage.removeProfile(segments[2]) ? 200 : 404, { ok: true })
      }
      if (segments[0] === 'v1' && segments[1] === 'agents' && segments[2]) {
        const id = segments[2]
        if (request.method === 'GET' && segments[3] === 'terminal-buffer') {
          const activeSession = options.worker?.get(id) ?? sessions.get(id)
          if (!activeSession) {
            clearTerminalOutput(terminalOutputRoot, id)
            return json(response, 200, { data: '' })
          }
          return json(response, 200, { data: readTerminalOutput(terminalOutputRoot, id) })
        }
        if (request.method === 'POST' && segments[3] === 'start') return json(response, 200, { ok: startWorker(id, String((await body(request, options.maxBodyBytes ?? 1_000_000)).taskId ?? '')) })
        if (request.method === 'POST' && segments[3] === 'stop') return json(response, 200, { ok: options.worker?.stop(id) ?? false })
        if (request.method === 'POST' && segments[3] === 'control') {
          const input = await body(request, options.maxBodyBytes ?? 1_000_000)
        const session = options.worker?.get(id) ?? sessions.get(id)
        if (!session) {
          const staleAgent = options.storage.getAgent(id)
          options.storage.setAgentStatus(id, 'offline')
          if (staleAgent?.projectId) broadcast({ projectId: staleAgent.projectId, type: 'agent.state', agentId: id, status: 'offline' })
          return json(response, 409, { error: 'Agent has no active session; status reset to offline', status: 'offline' })
        }
        sessions.set(id, session)
          if (input.action === 'steer' || input.action === 'constrain') session.write(`${String(input.text ?? '')}\n`)
          else if (input.action === 'interrupt') session.write('\u0003')
          else if (input.action === 'pause' || input.action === 'resume') return json(response, 409, { error: 'Pause/resume requires a process supervisor on the web worker' })
          return json(response, 200, { ok: true })
        }
        if (request.method === 'DELETE') return json(response, options.storage.removeAgent(id) ? 200 : 404, { ok: true })
      }
      if (url.pathname === '/v1/agents' && request.method === 'GET') return json(response, 200, options.storage.listAgents())
      if (url.pathname === '/v1/agents' && request.method === 'POST') return json(response, 201, options.storage.createAgent(await body(request, options.maxBodyBytes ?? 1_000_000) as Parameters<WebStorage['createAgent']>[0]))
      if (url.pathname === '/v1/fleet' && request.method === 'GET') return json(response, 200, options.storage.fleetSummary(url.searchParams.get('projectId') ?? undefined))
      if (url.pathname === '/v1/cli' && request.method === 'GET') return json(response, 200, detectCli())
      if (url.pathname === '/v1/github/status' && request.method === 'GET') return json(response, 200, { installed: false, authenticated: false })
      if (url.pathname === '/v1/github/import-issues' && request.method === 'POST') return json(response, 200, [])
      return json(response, 404, { error: 'Not found' })
    } catch (error) {
      return json(response, 400, { error: error instanceof Error ? error.message : 'Invalid request' })
    }
  })

  server.on('upgrade', (request, socket) => {
    const url = new URL(request.url ?? '/', 'http://localhost')
    const token = websocketToken(request)
    if (url.pathname !== '/v1/ws' || !token || !authorizeValue(`Bearer ${token}`, options.token)) return socket.destroy()
    const key = request.headers['sec-websocket-key']
    if (typeof key !== 'string') return socket.destroy()
    const protocols = String(request.headers['sec-websocket-protocol'] ?? '').split(',').map(value => value.trim())
    if (!protocols.includes('agent-office-v1')) return socket.destroy()
    const accept = createHash('sha1').update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64')
    const selectedProtocol = protocols.includes('agent-office-v1') ? '\r\nSec-WebSocket-Protocol: agent-office-v1' : ''
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}${selectedProtocol}\r\n\r\n`)
    const client: WebSocketClient = { socket }
    clients.add(client)
    socket.on('data', chunk => {
      const input = parseClientFrame(Buffer.from(chunk))
      if (!input) return
      if (input.type === 'subscribe' && typeof input.projectId === 'string') client.projectId = input.projectId
      if (input.type === 'terminal.write' && typeof input.agentId === 'string' && typeof input.data === 'string') sessions.get(input.agentId)?.write(input.data)
      if (input.type === 'terminal.resize' && typeof input.agentId === 'string' && Number.isInteger(input.cols) && Number.isInteger(input.rows)) sessions.get(input.agentId)?.resize(Number(input.cols), Number(input.rows))
    })
    socket.on('close', () => clients.delete(client))
    socket.on('error', () => clients.delete(client))
  })
  return { server, broadcast }
}

function detectCli() {
  return ['codex', 'opencode', 'claude', 'gemini', 'qwen', 'copilot'].map(command => {
    try { return { command, installed: true, path: execFileSync('sh', ['-lc', `command -v ${command}`], { encoding: 'utf8' }).trim() } } catch { return { command, installed: false, path: null } }
  })
}
