const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const Module = require('node:module')

const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-office-migration-smoke-'))
const projectPath = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-office-migration-project-'))
const dataPath = path.join(userData, 'data')
fs.mkdirSync(dataPath, { recursive: true })

const Database = require('better-sqlite3')
const legacyDb = new Database(path.join(dataPath, 'agent-office.db'))
legacyDb.exec(`
  CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, path TEXT NOT NULL UNIQUE);
  CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE profiles (id TEXT PRIMARY KEY, name TEXT NOT NULL, role TEXT NOT NULL, command TEXT NOT NULL, soul TEXT NOT NULL, built_in INTEGER NOT NULL DEFAULT 0);
  CREATE TABLE agents (id TEXT PRIMARY KEY, name TEXT NOT NULL, command TEXT NOT NULL, cwd TEXT NOT NULL, role TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'idle');
  CREATE TABLE messages (id INTEGER PRIMARY KEY AUTOINCREMENT, from_agent TEXT NOT NULL, to_agent TEXT NOT NULL, body TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
  CREATE TABLE tasks (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, title TEXT NOT NULL, prompt TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'backlog', agent_id TEXT, result TEXT, error TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
  CREATE TABLE memories (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, agent_id TEXT, title TEXT NOT NULL, category TEXT NOT NULL DEFAULT 'general', body TEXT NOT NULL, file_path TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
`)
legacyDb.prepare('INSERT INTO projects (id, name, path) VALUES (?, ?, ?)').run('legacy-project', 'Legacy project', projectPath)
legacyDb.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run('active_project_id', 'legacy-project')
legacyDb.prepare('INSERT INTO profiles (id, name, role, command, soul, built_in) VALUES (?, ?, ?, ?, ?, 0)').run('legacy-profile', 'Legacy', 'Implementation', 'sh', 'Legacy instructions')
legacyDb.prepare('INSERT INTO agents (id, name, command, cwd, role, status) VALUES (?, ?, ?, ?, ?, ?)').run('legacy-agent', 'Legacy agent', 'printf legacy', projectPath, 'Implementation', 'working')
legacyDb.prepare('INSERT INTO tasks (id, project_id, title, prompt, status, agent_id) VALUES (?, ?, ?, ?, ?, ?)').run('legacy-task', 'legacy-project', 'Interrupted task', 'Continue legacy task', 'running', 'legacy-agent')
legacyDb.prepare('INSERT INTO messages (from_agent, to_agent, body) VALUES (?, ?, ?)').run('legacy-agent', 'legacy-agent', 'legacy message')
const memoryPath = path.join(projectPath, 'legacy-memory.md')
fs.writeFileSync(memoryPath, '# Legacy memory\n\nMigrated.\n', 'utf8')
legacyDb.prepare('INSERT INTO memories (id, project_id, title, category, body, file_path) VALUES (?, ?, ?, ?, ?, ?)').run('legacy-memory', 'legacy-project', 'Legacy memory', 'general', 'Migrated.', memoryPath)
legacyDb.close()

const handlers = new Map()
const originalLoad = Module._load
const originalSetInterval = global.setInterval
const originalCwd = process.cwd
const intervals = []
const fakeApp = {
  isPackaged: false,
  getPath: () => userData,
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
Module._load = function (request, parent, isMain) {
  if (request === 'electron') return { app: fakeApp, BrowserWindow: FakeWindow, ipcMain: { handle: (name, handler) => handlers.set(name, handler), on: () => {} } }
  return originalLoad.call(this, request, parent, isMain)
}
process.cwd = () => projectPath
global.setInterval = callback => { intervals.push(callback); return intervals.length }
require(path.resolve(__dirname, '../out/main/index.js'))

setTimeout(() => {
  global.setInterval = originalSetInterval
  process.cwd = originalCwd
  const db = new Database(path.join(dataPath, 'agent-office.db'))
  const columns = table => new Set(db.prepare(`PRAGMA table_info("${table}")`).all().map(row => row.name))
  for (const [table, required] of Object.entries({
    projects: ['default_branch', 'use_worktrees', 'created_at'],
    agents: ['project_id', 'worktree_path', 'branch', 'profile_id', 'status'],
    messages: ['message_id', 'project_id', 'status', 'attempts', 'last_error'],
    tasks: ['mission_id', 'approval_status', 'review_status', 'review_notes', 'branch', 'budget_minutes', 'source_type', 'source_ref'],
    profiles: ['permissions_json'],
    memories: ['pinned', 'retention_days']
  })) {
    const missing = required.filter(column => !columns(table).has(column))
    if (missing.length > 0) throw new Error(`migration missing ${table}: ${missing.join(', ')}`)
  }
  const project = db.prepare('SELECT id, default_branch AS defaultBranch, use_worktrees AS useWorktrees FROM projects WHERE id=?').get('legacy-project')
  if (!project || project.defaultBranch !== 'HEAD' || project.useWorktrees !== 0) throw new Error('legacy project migration failed')
  const agent = db.prepare('SELECT project_id AS projectId, status FROM agents WHERE id=?').get('legacy-agent')
  if (!agent || agent.projectId !== 'legacy-project' || agent.status !== 'offline') throw new Error('interrupted agent recovery failed')
  const task = db.prepare('SELECT status, error FROM tasks WHERE id=?').get('legacy-task')
  if (!task || task.status !== 'failed' || !String(task.error).includes('Application restarted')) throw new Error('interrupted task recovery failed')
  const message = db.prepare('SELECT status, attempts FROM messages ORDER BY id LIMIT 1').get()
  if (!message || message.status !== 'delivered' || message.attempts !== 0) throw new Error('legacy message migration failed')
  const profile = db.prepare('SELECT permissions_json AS permissionsJson FROM profiles WHERE id=?').get('legacy-profile')
  if (!profile || JSON.parse(profile.permissionsJson).secrets !== undefined) throw new Error('legacy profile migration failed')
  db.close()
  try { fs.rmSync(userData, { recursive: true, force: true }) } catch {}
  try { fs.rmSync(projectPath, { recursive: true, force: true }) } catch {}
  console.log('database migration/recovery: ok')
  process.exit(0)
}, 100)
