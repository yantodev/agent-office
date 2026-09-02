import { createHash, timingSafeEqual } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { URL } from 'node:url'
import type { WebStorage } from './storage'

type WebServerOptions = { storage: WebStorage; token: string; maxBodyBytes?: number }
type WebSocketClient = { socket: import('node:stream').Duplex; projectId?: string }

function json(response: ServerResponse, status: number, payload: unknown) {
  const body = JSON.stringify(payload)
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  response.end(body)
}

function authorized(request: IncomingMessage, token: string) {
  const value = request.headers.authorization
  if (!value?.startsWith('Bearer ')) return false
  const expected = Buffer.from(token)
  const actual = Buffer.from(value.slice(7))
  return expected.length === actual.length && timingSafeEqual(createHash('sha256').update(expected).digest(), createHash('sha256').update(actual).digest())
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
  const header = Buffer.alloc(4)
  header[0] = 0x81
  header[1] = 126
  header.writeUInt16BE(data.length, 2)
  return Buffer.concat([header, data])
}

export function createWebServer(options: WebServerOptions) {
  const clients = new Set<WebSocketClient>()
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? '/', 'http://localhost')
      if (url.pathname === '/healthz' && request.method === 'GET') return json(response, 200, { ok: true })
      if (!authorized(request, options.token)) return json(response, 401, { error: 'Unauthorized' })
      const segments = url.pathname.split('/').filter(Boolean)
      if (request.method === 'GET' && segments[0] === 'v1' && segments[1] === 'projects' && segments.length === 2) return json(response, 200, options.storage.listProjects())
      if (request.method === 'GET' && segments[0] === 'v1' && segments[1] === 'projects' && segments[3]) {
        const projectId = segments[2]
        const resource = segments[3]
        const result = resource === 'tasks' ? options.storage.listTasks(projectId)
          : resource === 'events' ? options.storage.listEvents(projectId)
            : resource === 'messages' ? options.storage.listMessages(projectId)
              : resource === 'approvals' ? options.storage.listApprovals(projectId)
                : resource === 'memories' ? options.storage.listMemories(projectId) : undefined
        if (result) return json(response, 200, result)
      }
      if (request.method === 'POST' && segments[0] === 'v1' && segments[1] === 'approvals' && segments[3] === 'resolve') {
        const input = await body(request, options.maxBodyBytes ?? 1_000_000)
        const status = input.status === 'approved' || input.status === 'rejected' ? input.status : undefined
        if (!status || !options.storage.resolveApproval(segments[2], status)) return json(response, 409, { error: 'Approval is invalid or already resolved' })
        broadcast({ projectId: String(input.projectId ?? ''), type: 'approval.updated', approvalId: segments[2], status })
        return json(response, 200, { ok: true })
      }
      return json(response, 404, { error: 'Not found' })
    } catch (error) {
      return json(response, 400, { error: error instanceof Error ? error.message : 'Invalid request' })
    }
  })

  const broadcast = (event: { projectId?: string; type: string; [key: string]: unknown }) => {
    const payload = frame(event)
    for (const client of clients) {
      if (event.projectId && client.projectId && event.projectId !== client.projectId) continue
      try { client.socket.write(payload) } catch { clients.delete(client) }
    }
  }

  server.on('upgrade', (request, socket) => {
    const url = new URL(request.url ?? '/', 'http://localhost')
    if (url.pathname !== '/v1/ws' || !authorized(request, options.token)) return socket.destroy()
    const key = request.headers['sec-websocket-key']
    if (typeof key !== 'string') return socket.destroy()
    const accept = createHash('sha1').update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64')
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`)
    const client: WebSocketClient = { socket }
    clients.add(client)
    socket.on('data', chunk => {
      const buffer = Buffer.from(chunk)
      if (buffer.length < 2 || (buffer[0] & 0x0f) !== 1) return
      const length = buffer[1] & 0x7f
      if (length > 125 || buffer.length < 2 + 4 + length) return
      const mask = buffer.subarray(2, 6)
      const content = Buffer.from(buffer.subarray(6, 6 + length).map((value, index) => value ^ mask[index % 4])).toString('utf8')
      try {
        const input = JSON.parse(content) as { type?: string; projectId?: string }
        if (input.type === 'subscribe' && typeof input.projectId === 'string') client.projectId = input.projectId
      } catch { /* frame non-JSON diabaikan */ }
    })
    socket.on('close', () => clients.delete(client))
    socket.on('error', () => clients.delete(client))
  })
  return { server, broadcast }
}
