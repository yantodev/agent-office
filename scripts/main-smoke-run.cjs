const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { randomUUID } = require('node:crypto')
const { execFileSync } = require('node:child_process')
const Module = require('node:module')

const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-office-main-smoke-'))
const projectPath = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-office-project-smoke-'))
const repoPath = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-office-git-smoke-'))
const holdCommand = process.platform === 'win32' ? 'Start-Sleep -Seconds 5' : 'sleep 5'
const secretCommand = process.platform === 'win32' ? "Write-Output 'token=supersecret'" : "printf 'token=supersecret\\n'"
execFileSync('git', ['-C', repoPath, 'init'], { stdio: 'ignore' })
execFileSync('git', ['-C', repoPath, 'config', 'user.email', 'smoke@example.invalid'], { stdio: 'ignore' })
execFileSync('git', ['-C', repoPath, 'config', 'user.name', 'Agent Office Smoke'], { stdio: 'ignore' })
fs.writeFileSync(path.join(repoPath, 'README.md'), '# smoke\n', 'utf8')
execFileSync('git', ['-C', repoPath, 'add', 'README.md'], { stdio: 'ignore' })
execFileSync('git', ['-C', repoPath, 'commit', '-m', 'initial'], { stdio: 'ignore' })
const handlers = new Map()
const intervals = []
const fakeApp = {
  isPackaged: false,
  getPath: name => name === 'userData' ? userData : userData,
  whenReady: () => Promise.resolve(),
  on: () => {},
  disableHardwareAcceleration: () => {},
  commandLine: { appendSwitch: () => {} },
  quit: () => {}
}
class FakeWindow {
  loadURL() {}
  loadFile() {}
  static getAllWindows() { return [] }
}
const fakeElectron = { app: fakeApp, BrowserWindow: FakeWindow, ipcMain: { handle: (name, handler) => handlers.set(name, handler), on: () => {} } }
const originalLoad = Module._load
Module._load = function (request, parent, isMain) {
  if (request === 'electron') return fakeElectron
  return originalLoad.call(this, request, parent, isMain)
}
const originalSetInterval = global.setInterval
const originalCwd = process.cwd
process.cwd = () => projectPath
global.setInterval = callback => { intervals.push(callback); return intervals.length }
require(path.resolve(__dirname, '../out/main/index.js'))

setTimeout(async () => {
  global.setInterval = originalSetInterval
  process.cwd = originalCwd
  const Database = require('better-sqlite3')
  const db = new Database(path.join(userData, 'data', 'agent-office.db'))
  const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(row => row.name))
  const requiredTables = ['missions', 'schedules', 'approvals', 'task_dependencies', 'task_artifacts', 'execution_usage', 'commit_locks', 'github_issues', 'memory_vectors']
  const missing = requiredTables.filter(table => !tables.has(table))
  if (missing.length > 0) {
    console.error(`main smoke missing tables: ${missing.join(', ')}`)
    process.exit(2)
  }

  const call = async (name, input, event = {}) => {
    const handler = handlers.get(name)
    if (!handler) throw new Error(`missing IPC handler: ${name}`)
    return await handler(event, input)
  }
  const project = await call('projects:create', { id: 'smoke-project', name: 'Smoke Project', path: repoPath, useWorktrees: true })
  await call('projects:set-active', project.id)
  const firstAgent = await call('agents:create', { id: 'smoke-agent-1', name: 'Smoke One', role: 'Implementation', command: 'printf smoke', cwd: '.', projectId: project.id, profileId: 'developer' })
  const secondAgent = await call('agents:create', { id: 'smoke-agent-2', name: 'Smoke Two', role: 'Review', command: 'printf smoke', cwd: '.', projectId: project.id, profileId: 'reviewer' })
  await call('git:acquire-commit-lock', { projectId: project.id, agentId: firstAgent.id })
  let lockRejected = false
  try { await call('git:acquire-commit-lock', { projectId: project.id, agentId: secondAgent.id }) } catch { lockRejected = true }
  if (!lockRejected) throw new Error('single-committer lock smoke failed')
  if (!firstAgent.worktreePath || !secondAgent.worktreePath || firstAgent.worktreePath === secondAgent.worktreePath) throw new Error('isolated worktree smoke failed')
  fs.writeFileSync(path.join(firstAgent.worktreePath, 'README.md'), '# smoke committed\n', 'utf8')
  await call('git:commit', { agentId: firstAgent.id, message: 'smoke worker commit' })
  const latestCommit = execFileSync('git', ['-C', firstAgent.worktreePath, 'log', '-1', '--pretty=%s'], { encoding: 'utf8' }).trim()
  if (latestCommit !== 'smoke worker commit') throw new Error('git commit smoke failed')
  await call('git:acquire-commit-lock', { projectId: project.id, agentId: secondAgent.id })
  await call('git:release-commit-lock', { projectId: project.id, agentId: secondAgent.id })
  await handlers.get('agent:start')({ sender: { send: () => {} } }, { ...firstAgent, command: holdCommand })
  const controlEvent = { sender: { send: () => {} } }
  await call('agent:control', { id: firstAgent.id, action: 'pause' }, controlEvent)
  if ((await call('agents:list')).find(value => value.id === firstAgent.id).status !== 'paused') throw new Error('agent pause smoke failed')
  await call('agent:control', { id: firstAgent.id, action: 'resume' }, controlEvent)
  await call('agent:control', { id: firstAgent.id, action: 'constrain' }, controlEvent)
  let steerRejected = false
  try { await call('agent:control', { id: firstAgent.id, action: 'steer', text: 'expand scope' }, controlEvent) } catch { steerRejected = true }
  if (!steerRejected) throw new Error('circuit breaker smoke failed')
  await call('agent:stop', firstAgent.id)
  const message = await call('messages:send', { projectId: project.id, fromAgent: firstAgent.id, toAgent: secondAgent.id, body: 'hello smoke' })
  intervals[0]()
  const routedMessage = (await call('messages:list', project.id)).find(value => value.id === message.id)
  if (!routedMessage || routedMessage.status !== 'delivered') throw new Error('mailbox routing smoke failed')
  await call('messages:ack', { projectId: project.id, agentId: secondAgent.id, messageId: message.id })
  const retryMessage = await call('messages:send', { projectId: project.id, fromAgent: firstAgent.id, toAgent: secondAgent.id, body: 'retry smoke' })
  const retryPath = path.join(repoPath, '.agent-office', 'outbox', `${retryMessage.id}.json`)
  const retryPayload = JSON.parse(fs.readFileSync(retryPath, 'utf8'))
  retryPayload.toAgent = 'missing-agent'
  fs.writeFileSync(retryPath, JSON.stringify(retryPayload), 'utf8')
  intervals[0]()
  const retried = (await call('messages:list', project.id)).find(value => value.id === retryMessage.id)
  if (!retried || retried.status !== 'pending' || retried.attempts !== 1) throw new Error('mailbox retry smoke failed')
  retryPayload.toAgent = secondAgent.id
  fs.writeFileSync(retryPath, JSON.stringify(retryPayload), 'utf8')
  intervals[0]()
  const deliveredRetry = (await call('messages:list', project.id)).find(value => value.id === retryMessage.id)
  if (!deliveredRetry || deliveredRetry.status !== 'delivered') throw new Error('mailbox retry recovery smoke failed')
  await call('messages:ack', { projectId: project.id, agentId: secondAgent.id, messageId: retryMessage.id })
  const deadLetterName = `invalid-${randomUUID()}.json`
  const deadLetterPath = path.join(repoPath, '.agent-office', 'outbox', deadLetterName)
  fs.writeFileSync(deadLetterPath, '{invalid json', 'utf8')
  intervals[0]()
  if (!fs.existsSync(path.join(repoPath, '.agent-office', 'logs', 'dead-letter', deadLetterName))) throw new Error('mailbox dead-letter smoke failed')

  const parent = await call('tasks:create', { id: 'smoke-task-parent', projectId: project.id, title: 'Parent', prompt: 'Implement parent', agentId: firstAgent.id })
  const child = await call('tasks:create', { id: 'smoke-task-child', projectId: project.id, title: 'Child', prompt: 'Review parent', agentId: secondAgent.id, dependsOnTaskIds: [parent.id] })
  if (child.dependencies.length !== 1) throw new Error('task dependency smoke failed')
  await call('tasks:update', { id: parent.id, status: 'review' })
  const preparedPr = await call('github:prepare-pr', { taskId: parent.id })
  if (!preparedPr.approvalId || !preparedPr.diffStat) throw new Error('GitHub PR preflight smoke failed')
  const mission = await call('missions:create', { id: 'smoke-mission', projectId: project.id, request: '- Plan architecture\n- Review implementation' })
  if (mission.tasks.length !== 2) throw new Error('mission decomposition smoke failed')

  const scheduled = await call('schedules:create', { id: 'smoke-schedule', projectId: project.id, name: 'Heartbeat', prompt: 'Check project health', agentId: firstAgent.id, intervalMinutes: 5, nextRunAt: new Date(Date.now() - 1000).toISOString() })
  intervals[1]()
  if (!(await call('tasks:list', project.id)).some(value => value.title === `[Schedule] ${scheduled.name}`)) throw new Error('scheduler smoke failed')

  const risky = await call('tasks:create', { id: 'smoke-risky', projectId: project.id, title: 'Risky', prompt: 'delete temporary deployment', agentId: firstAgent.id })
  if (risky.approvalStatus !== 'pending' || risky.status !== 'blocked') throw new Error('approval gate smoke failed')
  const riskyApproval = (await call('approvals:list', project.id)).find(value => value.taskId === risky.id)
  await call('approvals:resolve', { id: riskyApproval.id, status: 'approved' })
  if ((await call('tasks:list', project.id)).find(value => value.id === risky.id).approvalStatus !== 'approved') throw new Error('approval resolution smoke failed')

  const configPath = path.join(repoPath, 'cli-config.json')
  fs.writeFileSync(configPath, '{"mode":"old"}\n', 'utf8')
  const config = await call('config:prepare', { projectId: project.id, path: configPath, content: '{"mode":"new","token":"supersecret"}\n' })
  if (config.diff.includes('supersecret')) throw new Error('config diff secret redaction smoke failed')
  await call('approvals:resolve', { id: config.approvalId, status: 'approved' })
  const applied = await call('config:apply', config.approvalId)
  if (!applied.backupPath || fs.readFileSync(configPath, 'utf8') !== '{"mode":"new","token":"supersecret"}\n' || fs.readFileSync(applied.backupPath, 'utf8') !== '{"mode":"old"}\n') throw new Error('config backup/apply smoke failed')
  const eventLog = fs.readFileSync(path.join(repoPath, '.agent-office', 'logs', 'events.jsonl'), 'utf8')
  if (eventLog.includes('supersecret')) throw new Error('event log secret redaction smoke failed')

  const secretTask = await call('tasks:create', { id: 'smoke-secret-task', projectId: project.id, title: 'Secret output', prompt: 'Print a diagnostic result', agentId: firstAgent.id })
  await handlers.get('agent:start')({ sender: { send: () => {} } }, { ...firstAgent, command: secretCommand, taskId: secretTask.id, taskPrompt: '' })
  await new Promise(resolve => setTimeout(resolve, 250))
  const persistedSecretTask = (await call('tasks:list', project.id)).find(value => value.id === secretTask.id)
  if (!persistedSecretTask || String(persistedSecretTask.result).includes('supersecret')) throw new Error('task output secret redaction smoke failed')

  await call('memories:save', { id: 'smoke-memory', projectId: project.id, title: 'SQLite decision', category: 'architecture', body: 'Use SQLite for durable local state.' })
  if (!(await call('memories:semantic-search', { projectId: project.id, query: 'durable SQLite state' })).some(value => value.id === 'smoke-memory')) throw new Error('semantic memory smoke failed')
  await call('memories:save', { id: 'smoke-expired', projectId: project.id, title: 'Expired note', category: 'temporary', body: 'This should be retained briefly.', retentionDays: 1 })
  await call('memories:save', { id: 'smoke-pinned', projectId: project.id, title: 'Pinned note', category: 'temporary', body: 'This should never expire.', retentionDays: 1, pinned: true })
  db.prepare("UPDATE memories SET updated_at=datetime('now', '-2 days') WHERE id IN ('smoke-expired', 'smoke-pinned')").run()
  if (await call('memories:prune', project.id) !== 1 || (await call('memories:list', { projectId: project.id })).some(value => value.id === 'smoke-expired')) throw new Error('memory retention smoke failed')
  if (!(await call('memories:list', { projectId: project.id })).some(value => value.id === 'smoke-pinned')) throw new Error('memory pin retention smoke failed')
  const secretMemory = await call('memories:save', { id: 'smoke-secret-memory', projectId: project.id, title: 'Secret note', category: 'temporary', body: 'password=supersecret' })
  if (secretMemory.body.includes('supersecret') || fs.readFileSync(secretMemory.filePath, 'utf8').includes('supersecret')) throw new Error('memory Markdown secret redaction smoke failed')
  await call('memories:remove', secretMemory.id)
  await call('agents:remove', firstAgent.id)
  await call('agents:remove', secondAgent.id)
  await call('projects:remove', project.id)
  console.log(`main process integration: ok (${requiredTables.length} tables, worktree/git lock, mailbox, tasks, mission, scheduler, approval, config, memory, circuit, PR preflight)`)
  db.close()
  try { fs.rmSync(userData, { recursive: true, force: true }) } catch {}
  try { fs.rmSync(projectPath, { recursive: true, force: true }) } catch {}
  try { fs.rmSync(repoPath, { recursive: true, force: true }) } catch {}
  process.exit(0)
}, 100)
