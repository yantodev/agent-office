import assert from 'node:assert/strict'
import { createWebServer } from '../src/web/server.ts'

const storage = {
  listProjects: () => [{ id: 'project-1', name: 'Smoke' }],
  listTasks: projectId => [{ projectId, id: 'task-1' }],
  listEvents: () => [],
  listMessages: () => [],
  listApprovals: () => [],
  listMemories: () => [],
  resolveApproval: () => true,
}
const app = createWebServer({ storage, token: 'smoke-token' })
await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve))
const address = app.server.address()
const base = `http://127.0.0.1:${address.port}`
assert.equal((await fetch(`${base}/healthz`)).status, 200)
assert.equal((await fetch(`${base}/v1/projects`)).status, 401)
const response = await fetch(`${base}/v1/projects`, { headers: { authorization: 'Bearer smoke-token' } })
assert.deepEqual(await response.json(), [{ id: 'project-1', name: 'Smoke' }])
const tasks = await fetch(`${base}/v1/projects/project-1/tasks`, { headers: { authorization: 'Bearer smoke-token' } })
assert.deepEqual(await tasks.json(), [{ projectId: 'project-1', id: 'task-1' }])
app.server.close()
console.log('web API smoke: ok')
