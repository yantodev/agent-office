import { app, BrowserWindow, ipcMain } from 'electron'
import { basename, dirname, join, resolve } from 'node:path'
import os from 'node:os'
import fs from 'node:fs'
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import pty from 'node-pty'
import Database from 'better-sqlite3'
import { assertTaskTransition, isTaskStatus, resolveTaskReadiness } from './task-lifecycle'
import type { BlockedReason, TaskStatus } from './task-lifecycle'
import { executionPlan } from './permission-policy'

type AgentStatus = 'idle' | 'working' | 'paused' | 'error' | 'offline'

type Agent = {
  id: string
  name: string
  command: string
  cwd: string
  role: string
  profileId?: string | null
  projectId?: string | null
  worktreePath?: string | null
  branch?: string | null
  dirty?: boolean
  status: AgentStatus
}

type Project = {
  id: string
  name: string
  path: string
  defaultBranch: string
  useWorktrees: number
}

type Task = {
  id: string
  projectId: string
  title: string
  prompt: string
  status: TaskStatus
  agentId?: string | null
  result?: string | null
  error?: string | null
  missionId?: string | null
  approvalStatus?: 'not_required' | 'pending' | 'approved' | 'rejected'
  reviewStatus?: 'pending' | 'approved' | 'changes_requested'
  reviewNotes?: string | null
  branch?: string | null
  budgetMinutes?: number | null
  blockedReason?: BlockedReason
}

type Schedule = {
  id: string
  projectId: string
  name: string
  prompt: string
  agentId?: string | null
  intervalMinutes: number
  timezone: string
  nextRunAt: string
  enabled: number
}

type Mission = {
  id: string
  projectId: string
  title: string
  request: string
  status: 'planned' | 'running' | 'review' | 'completed' | 'failed'
  createdAt: string
}

const projectFolders = ['inbox', 'outbox', 'tasks', 'memory', 'logs', 'pending-config']
const profilePermissionKeys = ['filesystem', 'network', 'shell', 'git', 'secrets'] as const
type ProfilePermission = typeof profilePermissionKeys[number]
type ProfilePermissions = Record<ProfilePermission, boolean>
const defaultProfilePermissions: ProfilePermissions = { filesystem: true, network: true, shell: true, git: true, secrets: false }

type AgentProfile = {
  id: string
  name: string
  role: string
  command: string
  soul: string
  builtIn: number
  permissions?: Record<string, boolean>
}

const sessions = new Map<string, pty.IPty>()
const taskOutputs = new Map<string, string>()
const taskRuns = new Map<string, { id: string; startedAt: number }>()
const taskTimeouts = new Map<string, NodeJS.Timeout>()
const watchdogNotices = new Map<string, number>()
const circuitStates = new Map<string, { steerCount: number; lastSteerAt: number; constrained: boolean }>()
let db: Database.Database
let mailboxRouter: NodeJS.Timeout | undefined
let scheduler: NodeJS.Timeout | undefined
let quitting = false

if (process.env.ELECTRON_DISABLE_GPU === '1') {
  app.disableHardwareAcceleration()
  app.commandLine.appendSwitch('disable-gpu')
}

function git(cwd: string, args: string[]) {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

function gitPreflight(cwd: string, baseBranch: string, headBranch: string) {
  // The three-tree form is supported by older Git releases, including Git 2.34.
  // `merge-tree --write-tree` was introduced later and cannot be the only path
  // here because PR preparation is also expected to work on older workstations.
  try {
    const mergeBase = git(cwd, ['merge-base', baseBranch, headBranch])
    const mergeOutput = execFileSync('git', ['-C', cwd, 'merge-tree', mergeBase, baseBranch, headBranch], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    if (/(?:changed|added|deleted) in both|^CONFLICT\b|^both (?:modified|added|deleted)\b/im.test(mergeOutput)) {
      return { ok: false, reason: 'conflict', detail: redactSecrets(mergeOutput).slice(0, 4_000) }
    }
  } catch (error) {
    const output = error && typeof error === 'object' && 'stderr' in error ? String(error.stderr) : 'Unable to calculate merge tree'
    return { ok: false, reason: 'conflict', detail: redactSecrets(output).slice(0, 4_000) }
  }
  try {
    execFileSync('git', ['-C', cwd, 'diff', '--check', `${baseBranch}...${headBranch}`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  } catch (error) {
    const output = error && typeof error === 'object' && 'stdout' in error ? String(error.stdout) : 'Whitespace errors detected'
    return { ok: false, reason: 'diff-check', detail: redactSecrets(output).slice(0, 4_000) }
  }
  return { ok: true as const }
}

function gh(cwd: string, args: string[]) {
  return execFileSync('gh', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

function isDirectory(path: string) {
  try {
    return fs.statSync(path).isDirectory()
  } catch {
    return false
  }
}

function normalizePermissions(value: unknown): ProfilePermissions {
  const source = value && typeof value === 'object' ? value as Record<string, unknown> : {}
  return profilePermissionKeys.reduce((permissions, key) => {
    if (typeof source[key] === 'boolean') permissions[key] = source[key] as boolean
    return permissions
  }, { ...defaultProfilePermissions })
}

function parsePermissions(value?: string): ProfilePermissions {
  try { return normalizePermissions(value ? JSON.parse(value) : {}) } catch { return { ...defaultProfilePermissions } }
}

function canonicalPath(path: string) {
  let current = resolve(path)
  const tail: string[] = []
  while (!fs.existsSync(current)) {
    const parent = dirname(current)
    if (parent === current) return resolve(path)
    tail.unshift(basename(current))
    current = parent
  }
  try { return join(fs.realpathSync.native(current), ...tail) } catch { return resolve(path) }
}

function isCanonicalPathInside(parent: string, candidate: string) {
  const root = canonicalPath(parent).replace(/[\\/]$/, '')
  const target = canonicalPath(candidate)
  return target === root || target.startsWith(`${root}${target.includes('\\') ? '\\' : '/'}`)
}

function projectConfigRoots(project: Project) {
  const home = os.homedir()
  return [
    project.path,
    join(home, '.codex'),
    join(home, '.claude'),
    join(home, '.config', 'opencode'),
    join(home, '.config', 'gemini'),
    join(home, '.config', 'qwen'),
    join(home, '.config', 'github-copilot')
  ]
}

function validateConfigPath(project: Project, value: string) {
  if (typeof value !== 'string' || !value.trim()) throw new Error('Config path is required')
  const configPath = resolve(value)
  const parentPath = dirname(configPath)
  if (!isDirectory(parentPath)) throw new Error('Config path parent does not exist')
  if (!projectConfigRoots(project).some(root => isCanonicalPathInside(root, parentPath))) {
    throw new Error('Config path must be inside the project or an approved CLI config directory')
  }
  if (fs.existsSync(configPath)) {
    const fileStat = fs.lstatSync(configPath)
    if (fileStat.isSymbolicLink() || fileStat.isDirectory() || !fileStat.isFile()) {
      throw new Error('Config path must be a regular file, not a symlink or directory')
    }
    if (!projectConfigRoots(project).some(root => isCanonicalPathInside(root, configPath))) {
      throw new Error('Config path resolves outside the approved directory')
    }
  }
  return configPath
}

function validateArtifactLocation(project: Project, value: string) {
  if (typeof value !== 'string' || !value.trim()) throw new Error('Artifact location is required')
  const location = value.trim()
  if (/^https:\/\//i.test(location)) return location
  if (/^[a-z][a-z0-9+.-]*:/i.test(location)) throw new Error('Artifact location only supports local paths or HTTPS URLs')
  const artifactPath = resolve(project.path, location)
  const worktreeRoot = join(app.getPath('userData'), 'worktrees', safePathSegment(project.id))
  if (!isCanonicalPathInside(project.path, artifactPath) && !isCanonicalPathInside(worktreeRoot, artifactPath)) {
    throw new Error('Artifact path must be inside the project or its agent worktrees')
  }
  if (fs.existsSync(artifactPath) && fs.lstatSync(artifactPath).isSymbolicLink()) {
    throw new Error('Artifact path cannot be a symbolic link')
  }
  return artifactPath
}

function validateMemoryPath(project: Project, value: string) {
  if (typeof value !== 'string' || !isCanonicalPathInside(join(ensureProjectWorkspace(project), 'memory'), value)) {
    throw new Error('Memory file must remain inside the project memory directory')
  }
  if (fs.existsSync(value) && fs.lstatSync(value).isSymbolicLink()) throw new Error('Memory file cannot be a symbolic link')
  return value
}

function assertTrustedRenderer(event: { senderFrame?: { url: string } | null }) {
  // Test harnesses do not have a WebContents frame; real Electron IPC events always do.
  if (!event.senderFrame) return
  const senderUrl = event.senderFrame.url
  if (app.isPackaged) {
    if (senderUrl.startsWith('file://')) return
  } else {
    const rendererUrl = process.env.ELECTRON_RENDERER_URL
    if (rendererUrl) {
      try {
        if (new URL(senderUrl).origin === new URL(rendererUrl).origin) return
      } catch { /* URL tidak valid */ }
    } else if (senderUrl.startsWith('file://')) return
  }
  throw new Error('Untrusted renderer IPC sender')
}

function validateCommand(command: string) {
  const value = command.trim()
  const executable = value.split(/\s+/, 1)[0] ?? ''
  if (!value || /[;&|><`$(){}\n\r]/.test(value) || !/^(?:[A-Za-z0-9._+/-]+|[A-Za-z]:[\\/][^\s]+)$/.test(executable)) {
    throw new Error('CLI command must start with a command name or absolute path and contain no shell operators')
  }
  return value
}

function terminalShell(command: string) {
  if (process.platform === 'win32') return { shell: 'powershell.exe', args: ['-NoLogo', '-NoProfile', '-Command', command] }
  return { shell: process.env.SHELL || '/bin/bash', args: ['-lc', command] }
}

function validateIdentifier(value: string, label: string) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(value)) throw new Error(`${label} must be a safe identifier`)
  return value
}

function safePathSegment(value: string) {
  return value.replace(/[^A-Za-z0-9._-]/g, '-').replace(/^[.-]+|[.-]+$/g, '').slice(0, 64) || 'workspace'
}

function redactSecrets(value: string) {
  return value
    .replace(/\b(?:sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9_]{12,}|xox[baprs]-[A-Za-z0-9-]{12,})\b/g, '[REDACTED_SECRET]')
    .replace(/\b((?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|secret|credential|token)\s*[:=]\s*)([^\s,;]+)/gi, '$1[REDACTED]')
    .replace(/((?:["']?\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|secret|credential|token)\b["']?)\s*[:=]\s*["']?)([^"'\s,;}]+)(["']?)/gi, '$1[REDACTED]$3')
}

function redactPayload(value: unknown): unknown {
  if (typeof value === 'string') return redactSecrets(value)
  if (Array.isArray(value)) return value.map(redactPayload)
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, redactPayload(entry)]))
  return value
}

function memoryVector(text: string) {
  const vector = new Array<number>(64).fill(0)
  const tokens = text.toLocaleLowerCase().match(/[\p{L}\p{N}]{2,}/gu) ?? []
  for (const token of tokens) {
    let hash = 2166136261
    for (const character of token) hash = Math.imul(hash ^ character.charCodeAt(0), 16777619)
    vector[Math.abs(hash) % vector.length] += 1
  }
  const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0)) || 1
  return vector.map(value => value / norm)
}

function vectorSimilarity(left: number[], right: number[]) {
  return left.reduce((sum, value, index) => sum + value * (right[index] ?? 0), 0)
}

function unifiedDiff(before: string, after: string) {
  const left = before.split(/\r?\n/)
  const right = after.split(/\r?\n/)
  if (before === after) return '(no changes)'
  const lines = [`--- current`, `+++ proposed`]
  const max = Math.max(left.length, right.length)
  for (let index = 0; index < max; index += 1) {
    if (left[index] === right[index]) lines.push(` ${redactSecrets(left[index] ?? '')}`)
    else {
      if (left[index] !== undefined) lines.push(`-${redactSecrets(left[index])}`)
      if (right[index] !== undefined) lines.push(`+${redactSecrets(right[index])}`)
    }
    if (lines.length >= 2002) { lines.push(' ... diff truncated ...'); break }
  }
  return lines.join('\n')
}

function gitBranch(path: string) {
  try {
    return git(path, ['branch', '--show-current']) || 'HEAD'
  } catch {
    return null
  }
}

function createWorktree(project: Project, agentId: string) {
  if (!project.useWorktrees || !gitBranch(project.path)) return { cwd: project.path, worktreePath: null, branch: null }
  const worktreePath = join(app.getPath('userData'), 'worktrees', safePathSegment(project.id), safePathSegment(agentId))
  const branchBase = agentId.replace(/[^A-Za-z0-9._-]/g, '-').replace(/^[.-]+|[.-]+$/g, '').slice(0, 32) || 'worker'
  const branch = `agent/${branchBase}-${randomUUID().slice(0, 8)}`
  fs.mkdirSync(join(app.getPath('userData'), 'worktrees', project.id), { recursive: true })
  git(project.path, ['worktree', 'add', '-b', branch, worktreePath, project.defaultBranch])
  return { cwd: worktreePath, worktreePath, branch }
}

function removeWorktree(project: Project | undefined, worktreePath: string | null | undefined) {
  if (!project || !worktreePath) return
  try { git(project.path, ['worktree', 'remove', worktreePath]) } catch { /* perubahan lokal tidak dihapus otomatis */ }
}

function ensureProjectWorkspace(project: Project) {
  const root = join(project.path, '.agent-office')
  for (const folder of projectFolders) fs.mkdirSync(join(root, folder), { recursive: true })
  return root
}

function writeJsonAtomic(path: string, value: unknown) {
  const temporaryPath = `${path}.${randomUUID()}.tmp`
  fs.writeFileSync(temporaryPath, JSON.stringify(value, null, 2), 'utf8')
  fs.renameSync(temporaryPath, path)
}

function writeTextAtomic(path: string, value: string) {
  const temporaryPath = `${path}.${randomUUID()}.tmp`
  fs.writeFileSync(temporaryPath, value, 'utf8')
  fs.renameSync(temporaryPath, path)
}

function routePendingMessages(project: Project) {
  const root = ensureProjectWorkspace(project)
  const outbox = join(root, 'outbox')
  for (const filename of fs.readdirSync(outbox)) {
    if (!filename.endsWith('.json')) continue
    const sourcePath = join(outbox, filename)
    let messageId: string | undefined
    try {
      const message = JSON.parse(fs.readFileSync(sourcePath, 'utf8')) as { id: string; toAgent: string }
      messageId = message.id
      if (!message.id || !message.toAgent) throw new Error('message requires id and toAgent')
      if (!/^[A-Za-z0-9_-]+$/.test(message.toAgent) || !db.prepare('SELECT 1 FROM agents WHERE id=? AND project_id=?').get(message.toAgent, project.id)) throw new Error('message recipient is not a valid project agent')
      const targetPath = join(root, 'inbox', `${message.toAgent}-${message.id}.json`)
      if (!fs.existsSync(targetPath)) writeJsonAtomic(targetPath, message)
      db.prepare("UPDATE messages SET status='delivered' WHERE message_id=? AND status!='dead-letter'").run(message.id)
      fs.rmSync(sourcePath, { force: true })
    } catch (error) {
      const reason = error instanceof Error ? error.message : 'invalid message'
      const attempts = messageId
        ? Number((db.prepare('SELECT attempts FROM messages WHERE message_id=?').get(messageId) as { attempts?: number } | undefined)?.attempts ?? 0) + 1
        : 3
      if (messageId) db.prepare('UPDATE messages SET attempts=?, last_error=?, status=? WHERE message_id=?').run(attempts, reason, attempts >= 3 ? 'dead-letter' : 'pending', messageId)
      if (attempts >= 3) {
        const deadLetterPath = join(root, 'logs', 'dead-letter')
        fs.mkdirSync(deadLetterPath, { recursive: true })
        try { fs.renameSync(sourcePath, join(deadLetterPath, filename)) } catch { /* file may be in-flight */ }
        recordEvent(project, null, 'message.dead-letter', { filename, reason, attempts })
      } else {
        recordEvent(project, null, 'message.retry', { filename, reason, attempts })
      }
    }
  }
}

function runMailboxWatchdog(project: Project) {
  const root = ensureProjectWorkspace(project)
  const now = Date.now()
  const staleAfterMs = 10 * 60_000
  for (const folder of ['inbox', 'outbox']) {
    for (const filename of fs.readdirSync(join(root, folder))) {
      if (!filename.endsWith('.json')) continue
      const path = join(root, folder, filename)
      let stat: fs.Stats
      try { stat = fs.statSync(path) } catch { continue }
      if (now - stat.mtimeMs < staleAfterMs) continue
      const key = `${project.id}/${folder}/${filename}`
      if (watchdogNotices.get(key) === stat.mtimeMs) continue
      watchdogNotices.set(key, stat.mtimeMs)
      recordEvent(project, null, 'mailbox.stalled', { folder, filename, ageMs: Math.round(now - stat.mtimeMs) })
    }
  }
}

function startMailboxRouter() {
  const route = () => {
    const projects = db.prepare('SELECT id, name, path, default_branch AS defaultBranch, use_worktrees AS useWorktrees FROM projects').all() as Project[]
    for (const project of projects) {
      try {
        routePendingMessages(project)
        runMailboxWatchdog(project)
      } catch { /* router akan mencoba lagi pada interval berikutnya */ }
    }
  }
  route()
  return setInterval(route, 2000)
}

function recordEvent(project: Project | undefined, agentId: string | null, type: string, payload: Record<string, unknown> = {}) {
  if (!project) return
  const event = { id: randomUUID(), projectId: project.id, agentId, type, createdAt: new Date().toISOString(), payload: redactPayload(payload) as Record<string, unknown> }
  db.prepare('INSERT INTO events (id, project_id, agent_id, type, payload_json) VALUES (?, ?, ?, ?, ?)')
    .run(event.id, event.projectId, event.agentId, event.type, JSON.stringify(event.payload))
  const root = ensureProjectWorkspace(project)
  fs.appendFileSync(join(root, 'logs', 'events.jsonl'), `${JSON.stringify(event)}\n`, 'utf8')
}

function ensureColumn(table: string, column: string, definition: string) {
  const columns = db.prepare(`PRAGMA table_info("${table}")`).all() as Array<{ name: string }>
  if (!columns.some(current => current.name === column)) db.exec(`ALTER TABLE "${table}" ADD COLUMN "${column}" ${definition}`)
}

function initDb() {
  const dir = join(app.getPath('userData'), 'data')
  fs.mkdirSync(dir, { recursive: true })
  db = new Database(join(dir, 'agent-office.db'))
  db.pragma('foreign_keys = ON')
  db.exec(`
    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      path TEXT NOT NULL UNIQUE,
      default_branch TEXT NOT NULL DEFAULT 'HEAD',
      use_worktrees INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS profiles (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      role TEXT NOT NULL,
      command TEXT NOT NULL DEFAULT 'codex',
      soul TEXT NOT NULL DEFAULT '',
      permissions_json TEXT NOT NULL DEFAULT '{}',
      built_in INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS missions (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      request TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'planned',
      summary TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS agents (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      command TEXT NOT NULL,
      cwd TEXT NOT NULL,
      role TEXT NOT NULL,
      project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
      worktree_path TEXT,
      branch TEXT,
      profile_id TEXT REFERENCES profiles(id) ON DELETE SET NULL,
      status TEXT NOT NULL DEFAULT 'idle'
    );
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      message_id TEXT UNIQUE,
      project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
      from_agent TEXT NOT NULL,
      to_agent TEXT NOT NULL,
      body TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'delivered',
      attempts INTEGER NOT NULL DEFAULT 0,
      last_error TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      prompt TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'backlog',
      agent_id TEXT REFERENCES agents(id) ON DELETE SET NULL,
      result TEXT,
      error TEXT,
      mission_id TEXT REFERENCES missions(id) ON DELETE SET NULL,
      approval_status TEXT NOT NULL DEFAULT 'not_required',
      review_status TEXT NOT NULL DEFAULT 'pending',
      review_notes TEXT,
      blocked_reason TEXT,
      branch TEXT,
      budget_minutes INTEGER,
      source_type TEXT,
      source_ref TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS task_dependencies (
      task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      depends_on_task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      PRIMARY KEY (task_id, depends_on_task_id),
      CHECK (task_id != depends_on_task_id)
    );
    CREATE TABLE IF NOT EXISTS task_artifacts (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      label TEXT NOT NULL,
      kind TEXT NOT NULL DEFAULT 'file',
      location TEXT NOT NULL,
      metadata_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS approvals (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      task_id TEXT REFERENCES tasks(id) ON DELETE CASCADE,
      type TEXT NOT NULL,
      title TEXT NOT NULL,
      reason TEXT NOT NULL,
      payload_json TEXT NOT NULL DEFAULT '{}',
      status TEXT NOT NULL DEFAULT 'pending',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      resolved_at TEXT
    );
    CREATE TABLE IF NOT EXISTS schedules (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      prompt TEXT NOT NULL,
      agent_id TEXT REFERENCES agents(id) ON DELETE SET NULL,
      interval_minutes INTEGER NOT NULL CHECK (interval_minutes > 0),
      timezone TEXT NOT NULL DEFAULT 'UTC',
      next_run_at TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS execution_usage (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      agent_id TEXT REFERENCES agents(id) ON DELETE SET NULL,
      started_at TEXT NOT NULL,
      finished_at TEXT,
      duration_ms INTEGER,
      output_bytes INTEGER NOT NULL DEFAULT 0,
      exit_code INTEGER
    );
    CREATE TABLE IF NOT EXISTS commit_locks (
      project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
      agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
      acquired_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS github_issues (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      issue_number INTEGER NOT NULL,
      title TEXT NOT NULL,
      body TEXT NOT NULL DEFAULT '',
      url TEXT,
      state TEXT NOT NULL,
      labels_json TEXT NOT NULL DEFAULT '[]',
      task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
      synced_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(project_id, issue_number)
    );
    CREATE TABLE IF NOT EXISTS events (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      agent_id TEXT,
      type TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS memories (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      agent_id TEXT REFERENCES agents(id) ON DELETE SET NULL,
      title TEXT NOT NULL,
      category TEXT NOT NULL DEFAULT 'general',
      body TEXT NOT NULL,
      file_path TEXT NOT NULL,
      pinned INTEGER NOT NULL DEFAULT 0,
      retention_days INTEGER,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS memory_vectors (
      memory_id TEXT PRIMARY KEY REFERENCES memories(id) ON DELETE CASCADE,
      vector_json TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `)

  ensureColumn('projects', 'default_branch', "TEXT NOT NULL DEFAULT 'HEAD'")
  ensureColumn('projects', 'use_worktrees', 'INTEGER NOT NULL DEFAULT 0')
  ensureColumn('projects', 'created_at', 'TEXT')
  db.prepare("UPDATE projects SET created_at=CURRENT_TIMESTAMP WHERE created_at IS NULL").run()
  ensureColumn('agents', 'project_id', 'TEXT REFERENCES projects(id) ON DELETE SET NULL')
  ensureColumn('agents', 'worktree_path', 'TEXT')
  ensureColumn('agents', 'branch', 'TEXT')
  ensureColumn('agents', 'profile_id', 'TEXT REFERENCES profiles(id) ON DELETE SET NULL')
  ensureColumn('agents', 'status', "TEXT NOT NULL DEFAULT 'idle'")
  ensureColumn('messages', 'message_id', 'TEXT')
  ensureColumn('messages', 'project_id', 'TEXT REFERENCES projects(id) ON DELETE CASCADE')
  ensureColumn('messages', 'status', "TEXT NOT NULL DEFAULT 'delivered'")
  ensureColumn('messages', 'attempts', 'INTEGER NOT NULL DEFAULT 0')
  ensureColumn('messages', 'last_error', 'TEXT')
  ensureColumn('tasks', 'mission_id', 'TEXT REFERENCES missions(id) ON DELETE SET NULL')
  ensureColumn('tasks', 'approval_status', "TEXT NOT NULL DEFAULT 'not_required'")
  ensureColumn('tasks', 'review_status', "TEXT NOT NULL DEFAULT 'pending'")
  ensureColumn('tasks', 'review_notes', 'TEXT')
  ensureColumn('tasks', 'blocked_reason', 'TEXT')
  ensureColumn('tasks', 'branch', 'TEXT')
  ensureColumn('tasks', 'budget_minutes', 'INTEGER')
  ensureColumn('tasks', 'source_type', 'TEXT')
  ensureColumn('tasks', 'source_ref', 'TEXT')
  ensureColumn('profiles', 'permissions_json', "TEXT NOT NULL DEFAULT '{}'")
  ensureColumn('memories', 'pinned', 'INTEGER NOT NULL DEFAULT 0')
  ensureColumn('memories', 'retention_days', 'INTEGER')

  const seedProfile = db.prepare('INSERT OR IGNORE INTO profiles (id, name, role, command, soul, built_in) VALUES (?, ?, ?, ?, ?, 1)')
  const profiles = [
    ['michael', 'Michael', 'Orchestration & delivery', 'codex', 'You are Michael, the supervisor. Turn a user request into small verifiable tasks, assign work to specialists, track dependencies, and report risks. Do not edit another agent\'s worktree or commit on its behalf. Ask for approval before destructive, scope-expanding, or costly actions.'],
    ['architect', 'Architect', 'Architecture & planning', 'codex', 'You are the architecture lead. Clarify constraints, map dependencies, and propose a small, testable plan before implementation. Prefer simple boundaries and document important trade-offs.'],
    ['developer', 'Developer', 'Implementation', 'opencode', 'You are the implementation specialist. Make focused changes, preserve existing behavior, and verify the result with the smallest useful test or build command.'],
    ['devops', 'DevOps', 'Infrastructure & deployment', 'codex', 'You are the DevOps specialist. Favor reproducible environments, observable commands, safe rollouts, and explicit rollback paths.'],
    ['reviewer', 'Reviewer', 'Code review & testing', 'opencode', 'You are a rigorous reviewer. Look for correctness, regressions, security issues, and missing tests. Report concrete findings with file and line references.']
  ]
  for (const profile of profiles) seedProfile.run(...profile)

  const defaultProjectPath = resolve(process.cwd())
  const defaultProjectBranch = gitBranch(defaultProjectPath) ?? 'HEAD'
  let defaultProject = getProject('default-project')
  if (!defaultProject) {
    const existingProject = db.prepare('SELECT id FROM projects WHERE path=?').get(defaultProjectPath) as { id: string } | undefined
    if (existingProject) defaultProject = getProject(existingProject.id)
    else {
      db.prepare('INSERT OR IGNORE INTO projects (id, name, path, default_branch, use_worktrees) VALUES (?, ?, ?, ?, 0)')
        .run('default-project', basename(defaultProjectPath) || 'Workspace', defaultProjectPath, defaultProjectBranch)
      defaultProject = getProject('default-project')
    }
  }
  const activeSetting = db.prepare("SELECT value FROM settings WHERE key='active_project_id'").get() as { value: string } | undefined
  if (defaultProject && (!activeSetting || !getProject(activeSetting.value))) {
    db.prepare("INSERT INTO settings (key, value) VALUES ('active_project_id', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(defaultProject.id)
  }
  if (defaultProject) db.prepare('UPDATE agents SET project_id=? WHERE project_id IS NULL').run(defaultProject.id)
  if (defaultProject) ensureProjectWorkspace(defaultProject)
  try {
    db.exec('CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(memory_id UNINDEXED, title, category, body)')
    db.exec('INSERT OR IGNORE INTO memories_fts (memory_id, title, category, body) SELECT id, title, category, body FROM memories')
  } catch { /* SQLite build tanpa FTS5 memakai pencarian LIKE */ }
  const memoryRows = db.prepare('SELECT id, title, category, body FROM memories').all() as Array<{ id: string; title: string; category: string; body: string }>
  const insertVector = db.prepare('INSERT OR IGNORE INTO memory_vectors (memory_id, vector_json) VALUES (?, ?)')
  for (const memory of memoryRows) insertVector.run(memory.id, JSON.stringify(memoryVector(`${memory.title} ${memory.category} ${memory.body}`)))
  recoverInterruptedSessions()
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1100,
    minHeight: 700,
    backgroundColor: '#0f172a',
    icon: join(__dirname, '../../assets/logo/logo.png'),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      sandbox: false
    }
  })

  win.webContents.on('will-navigate', event => event.preventDefault())
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))

  if (!app.isPackaged && process.env.ELECTRON_RENDERER_URL) {
    win.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

function getProject(id: string) {
  return db.prepare('SELECT id, name, path, default_branch AS defaultBranch, use_worktrees AS useWorktrees FROM projects WHERE id=?').get(id) as Project | undefined
}

function getActiveProject() {
  const setting = db.prepare("SELECT value FROM settings WHERE key='active_project_id'").get() as { value: string } | undefined
  return setting ? getProject(setting.value) : undefined
}

function requiresApproval(text: string) {
  return /\b(rm|delete|drop|truncate|destroy|push|force[- ]push|deploy|publish|credential|secret|password|sudo|cost|budget)\b/i.test(text)
}

function taskRow(id: string) {
  const task = db.prepare(`
    SELECT t.id, t.project_id AS projectId, t.title, t.prompt, t.status,
      t.agent_id AS agentId, t.result, t.error, t.mission_id AS missionId,
      t.approval_status AS approvalStatus, t.review_status AS reviewStatus,
      t.review_notes AS reviewNotes, t.blocked_reason AS blockedReason, t.branch, t.budget_minutes AS budgetMinutes,
      t.source_type AS sourceType, t.source_ref AS sourceRef, t.created_at AS createdAt,
      t.updated_at AS updatedAt, a.name AS agentName
    FROM tasks t LEFT JOIN agents a ON a.id=t.agent_id WHERE t.id=?
  `).get(id) as (Task & { createdAt?: string; updatedAt?: string; agentName?: string }) | undefined
  if (!task) return undefined
  const dependencies = db.prepare(`
    SELECT d.depends_on_task_id AS id, t.title, t.status
    FROM task_dependencies d JOIN tasks t ON t.id=d.depends_on_task_id WHERE d.task_id=?
  `).all(id)
  const artifacts = (db.prepare(`
    SELECT id, label, kind, location, metadata_json AS metadataJson, created_at AS createdAt
    FROM task_artifacts WHERE task_id=? ORDER BY created_at DESC
  `).all(id) as Array<{ metadataJson: string } & Record<string, unknown>>).map(artifact => ({
    ...artifact,
    metadata: JSON.parse(artifact.metadataJson),
    metadataJson: undefined
  }))
  return { ...task, dependencies, artifacts }
}

function dependenciesReady(taskId: string) {
  const pending = db.prepare(`
    SELECT 1 FROM task_dependencies d JOIN tasks t ON t.id=d.depends_on_task_id
    WHERE d.task_id=? AND t.status!='done' LIMIT 1
  `).get(taskId)
  return !pending
}

function dependencyIdsReady(dependencyIds: string[]) {
  return dependencyIds.every(dependencyId => {
    const dependency = db.prepare('SELECT status FROM tasks WHERE id=?').get(dependencyId) as { status: TaskStatus } | undefined
    return dependency?.status === 'done'
  })
}

function promoteDependentTasks(projectId: string) {
  const candidates = db.prepare(`
    SELECT id, status, agent_id AS agentId, approval_status AS approvalStatus, blocked_reason AS blockedReason
    FROM tasks WHERE project_id=? AND status='blocked' AND blocked_reason='dependencies'
  `).all(projectId) as Array<{ id: string; status: TaskStatus; agentId?: string | null; approvalStatus: string; blockedReason?: string | null }>
  for (const task of candidates) {
    if (task.approvalStatus === 'pending' || !dependenciesReady(task.id)) continue
    const nextStatus = resolveTaskReadiness(task.agentId, true, false).status
    db.prepare('UPDATE tasks SET status=?, blocked_reason=NULL, updated_at=CURRENT_TIMESTAMP WHERE id=?').run(nextStatus, task.id)
    recordEvent(getProject(projectId), task.agentId ?? null, 'task.unblocked', { taskId: task.id, status: nextStatus, reason: 'dependencies-complete' })
  }
}

function refreshMissionStatus(missionId: string | null | undefined) {
  if (!missionId) return
  const counts = db.prepare('SELECT COUNT(*) AS total, SUM(status=\'done\') AS done, SUM(status=\'review\') AS review, SUM(status=\'failed\') AS failed, SUM(status=\'running\') AS running FROM tasks WHERE mission_id=?').get(missionId) as { total: number; done: number; review: number; failed: number; running: number }
  const status = counts.failed > 0 ? 'failed' : counts.total > 0 && counts.done === counts.total ? 'completed' : counts.review > 0 ? 'review' : counts.running > 0 ? 'running' : 'planned'
  db.prepare('UPDATE missions SET status=?, updated_at=CURRENT_TIMESTAMP WHERE id=?').run(status, missionId)
}

function recoverInterruptedSessions() {
  const interrupted = db.prepare("SELECT id, project_id AS projectId FROM agents WHERE status IN ('working', 'paused')").all() as Array<{ id: string; projectId?: string | null }>
  if (interrupted.length === 0) return
  db.prepare("UPDATE agents SET status='offline' WHERE status IN ('working', 'paused')").run()
  db.prepare("DELETE FROM commit_locks WHERE agent_id IN (SELECT id FROM agents WHERE status='offline')").run()
  for (const agent of interrupted) {
    const tasks = db.prepare("SELECT id, mission_id AS missionId FROM tasks WHERE agent_id=? AND status='running'").all(agent.id) as Array<{ id: string; missionId?: string | null }>
    for (const task of tasks) {
      db.prepare("UPDATE tasks SET status='failed', blocked_reason=NULL, error=?, updated_at=CURRENT_TIMESTAMP WHERE id=?")
        .run('Application restarted before the task completed', task.id)
      refreshMissionStatus(task.missionId)
    }
    const project = agent.projectId ? getProject(agent.projectId) : undefined
    recordEvent(project, agent.id, 'agent.recovered', { interruptedTasks: tasks.map(task => task.id) })
  }
}

function profileForRequest(text: string) {
  const lower = text.toLowerCase()
  if (/\b(architecture|architect|design|plan|schema|decision)\b/.test(lower)) return 'architect'
  if (/\b(deploy|docker|ci|cd|infra|release|build pipeline|linux|server)\b/.test(lower)) return 'devops'
  if (/\b(test|review|qa|verify|audit|regression)\b/.test(lower)) return 'reviewer'
  return 'developer'
}

function profilePermissions(profileId: string | null | undefined) {
  if (!profileId) return { ...defaultProfilePermissions }
  const row = db.prepare('SELECT permissions_json AS permissionsJson FROM profiles WHERE id=?').get(profileId) as { permissionsJson?: string } | undefined
  return parsePermissions(row?.permissionsJson)
}

function decomposeRequest(request: string) {
  const lines = request.split(/\r?\n/).map(line => line.trim()).filter(Boolean)
  const bullets = lines.filter(line => /^(?:[-*•]|\d+[.)])\s+/.test(line)).map(line => line.replace(/^(?:[-*•]|\d+[.)])\s+/, '').trim())
  if (bullets.length > 0) return bullets.slice(0, 20)
  const sentences = request.split(/(?<=[.!?])\s+/).map(sentence => sentence.trim()).filter(sentence => sentence.length > 12)
  return (sentences.length > 0 ? sentences : [request.trim()]).slice(0, 20)
}

function processSchedules() {
  const now = new Date()
  const due = db.prepare(`
    SELECT id, project_id AS projectId, name, prompt, agent_id AS agentId,
      interval_minutes AS intervalMinutes, timezone, next_run_at AS nextRunAt, enabled
    FROM schedules WHERE enabled=1 AND next_run_at<=? ORDER BY next_run_at
  `).all(now.toISOString()) as Schedule[]
  for (const schedule of due) {
    const project = getProject(schedule.projectId)
    if (!project) continue
    const run = db.transaction(() => {
      let next = new Date(schedule.nextRunAt)
      do next = new Date(next.getTime() + schedule.intervalMinutes * 60_000)
      while (next <= now)
      const taskId = randomUUID()
      const approvalStatus = requiresApproval(schedule.prompt) ? 'pending' : 'not_required'
      const readiness = resolveTaskReadiness(schedule.agentId, true, approvalStatus === 'pending')
      const status = readiness.status
      db.prepare(`UPDATE schedules SET next_run_at=?, updated_at=CURRENT_TIMESTAMP WHERE id=?`).run(next.toISOString(), schedule.id)
      db.prepare(`INSERT INTO tasks (id, project_id, title, prompt, status, agent_id, approval_status, blocked_reason) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(taskId, project.id, `[Schedule] ${schedule.name}`, schedule.prompt, status, schedule.agentId ?? null, approvalStatus, readiness.blockedReason)
      if (approvalStatus === 'pending') {
        db.prepare(`INSERT INTO approvals (id, project_id, task_id, type, title, reason, payload_json) VALUES (?, ?, ?, ?, ?, ?, ?)`)
          .run(randomUUID(), project.id, taskId, 'safety', `Approve scheduled task: ${schedule.name}`, 'Scheduled prompt contains a potentially destructive, scope-changing, or costly operation.', JSON.stringify({ prompt: schedule.prompt }))
      }
      recordEvent(project, schedule.agentId ?? null, 'schedule.triggered', { scheduleId: schedule.id, taskId })
    })
    try { run() } catch { /* percobaan berikutnya tetap memakai next_run_at yang durable */ }
  }
}

function pruneExpiredMemories(projectId?: string) {
  const projects = projectId ? [getProject(projectId)].filter(Boolean) as Project[] : db.prepare('SELECT id, name, path, default_branch AS defaultBranch, use_worktrees AS useWorktrees FROM projects').all() as Project[]
  let removed = 0
  for (const project of projects) {
    const expired = db.prepare(`SELECT id, file_path AS filePath FROM memories
      WHERE project_id=? AND pinned=0 AND retention_days IS NOT NULL
      AND datetime(updated_at, '+' || retention_days || ' days') < CURRENT_TIMESTAMP`).all(project.id) as Array<{ id: string; filePath: string }>
    for (const memory of expired) {
      try {
        validateMemoryPath(project, memory.filePath)
        fs.rmSync(memory.filePath, { force: true })
        fs.rmSync(`${memory.filePath}.metadata`, { force: true })
      } catch (error) {
        recordEvent(project, null, 'memory.expiry-blocked', { memoryId: memory.id, reason: error instanceof Error ? error.message : 'invalid memory path' })
        continue
      }
      db.prepare('DELETE FROM memories WHERE id=?').run(memory.id)
      recordEvent(project, null, 'memory.expired', { memoryId: memory.id })
      removed += 1
    }
  }
  return removed
}

function startScheduler() {
  processSchedules()
  pruneExpiredMemories()
  return setInterval(() => { processSchedules(); pruneExpiredMemories() }, 30_000)
}

function registerIpc() {
  const nativeHandle = ipcMain.handle.bind(ipcMain)
  ipcMain.handle = ((channel, listener) => {
    nativeHandle(channel, (event, ...args) => {
      assertTrustedRenderer(event)
      return listener(event, ...args)
    })
  }) as typeof ipcMain.handle

  ipcMain.handle('projects:list', () => {
    return db.prepare('SELECT id, name, path, default_branch AS defaultBranch, use_worktrees AS useWorktrees FROM projects ORDER BY name').all()
  })

  ipcMain.handle('projects:active', () => getActiveProject() ?? null)

  ipcMain.handle('projects:create', (_event, input: { id: string; name: string; path: string; useWorktrees: boolean }) => {
    validateIdentifier(input.id, 'Project id')
    const path = resolve(input.path)
    if (!isDirectory(path)) throw new Error('Workspace path does not exist or is not a directory')
    const branch = gitBranch(path) ?? 'HEAD'
    db.prepare('INSERT INTO projects (id, name, path, default_branch, use_worktrees) VALUES (?, ?, ?, ?, ?)')
      .run(input.id, input.name.trim() || basename(path), path, branch, input.useWorktrees ? 1 : 0)
    return getProject(input.id)
  })

  ipcMain.handle('projects:set-active', (_event, id: string) => {
    if (!getProject(id)) throw new Error('Project not found')
    db.prepare("INSERT INTO settings (key, value) VALUES ('active_project_id', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(id)
    return getProject(id)
  })

  ipcMain.handle('projects:remove', (_event, id: string) => {
    if (id === 'default-project' || db.prepare('SELECT 1 FROM agents WHERE project_id=? LIMIT 1').get(id)) return false
    const result = db.prepare('DELETE FROM projects WHERE id=?').run(id)
    return result.changes > 0
  })

  ipcMain.handle('tasks:list', (_event, projectId?: string) => {
    const project = projectId ?? getActiveProject()?.id
    if (!project) return []
    const tasks = db.prepare('SELECT id FROM tasks WHERE project_id=? ORDER BY created_at DESC').all(project) as Array<{ id: string }>
    return tasks.map(task => taskRow(task.id)).filter(Boolean)
  })

  ipcMain.handle('tasks:create', (_event, input: { id: string; projectId: string; title: string; prompt: string; agentId?: string | null; dependsOnTaskIds?: string[]; branch?: string | null; budgetMinutes?: number | null; sourceType?: string | null; sourceRef?: string | null }) => {
    validateIdentifier(input.id, 'Task id')
    const project = getProject(input.projectId)
    if (!project || typeof input.title !== 'string' || typeof input.prompt !== 'string' || !input.title.trim() || !input.prompt.trim()) throw new Error('Invalid task')
    const agentId = input.agentId || null
    if (agentId && !db.prepare('SELECT 1 FROM agents WHERE id=? AND project_id=?').get(agentId, project.id)) throw new Error('Task agent must belong to the same project')
    const prompt = input.prompt.trim()
    const approvalStatus = requiresApproval(prompt) ? 'pending' : 'not_required'
    const budgetMinutes = input.budgetMinutes == null ? null : Math.floor(Number(input.budgetMinutes))
    if (budgetMinutes !== null && (!Number.isFinite(budgetMinutes) || budgetMinutes < 1)) throw new Error('Budget must be at least one minute')
    const dependencies = [...new Set(input.dependsOnTaskIds ?? [])]
    for (const dependencyId of dependencies) {
      const dependency = db.prepare('SELECT project_id AS projectId FROM tasks WHERE id=?').get(dependencyId) as { projectId: string } | undefined
      if (!dependency || dependency.projectId !== project.id || dependencyId === input.id) throw new Error('Invalid task dependency')
    }
    const dependenciesReadyNow = dependencyIdsReady(dependencies)
    const readiness = resolveTaskReadiness(agentId, dependenciesReadyNow, approvalStatus === 'pending')
    const status = readiness.status
    const blockedReason = readiness.blockedReason
    const transaction = db.transaction(() => {
      db.prepare(`INSERT INTO tasks (id, project_id, title, prompt, status, agent_id, approval_status, blocked_reason, branch, budget_minutes, source_type, source_ref)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(input.id, project.id, input.title.trim(), prompt, status, agentId, approvalStatus, blockedReason, input.branch ?? null, budgetMinutes, input.sourceType ?? null, input.sourceRef ?? null)
      const insertDependency = db.prepare('INSERT INTO task_dependencies (task_id, depends_on_task_id) VALUES (?, ?)')
      for (const dependencyId of dependencies) insertDependency.run(input.id, dependencyId)
      if (approvalStatus === 'pending') {
        db.prepare(`INSERT INTO approvals (id, project_id, task_id, type, title, reason, payload_json) VALUES (?, ?, ?, ?, ?, ?, ?)`)
          .run(randomUUID(), project.id, input.id, 'safety', `Approve task: ${input.title.trim()}`, 'Prompt contains a potentially destructive, scope-changing, or costly operation.', JSON.stringify({ prompt }))
      }
    })
    transaction()
    recordEvent(project, agentId, 'task.created', { taskId: input.id, title: input.title.trim(), approvalStatus, blockedReason, dependencies })
    return taskRow(input.id)
  })

  ipcMain.handle('tasks:update', (_event, input: { id: string; status?: TaskStatus; agentId?: string | null; result?: string | null; error?: string | null; reviewStatus?: 'pending' | 'approved' | 'changes_requested'; reviewNotes?: string | null; branch?: string | null }) => {
    const task = db.prepare('SELECT id, project_id AS projectId, title, prompt, status, agent_id AS agentId, result, error, review_status AS reviewStatus, review_notes AS reviewNotes, blocked_reason AS blockedReason, branch FROM tasks WHERE id=?').get(input.id) as Task | undefined
    if (!task) throw new Error('Task not found')
    const agentId = input.agentId === undefined ? task.agentId ?? null : input.agentId
    const requestedStatus = input.status ?? task.status
    if (!isTaskStatus(requestedStatus)) throw new Error('Invalid task status')
    let status = requestedStatus
    let blockedReason = task.blockedReason ?? null
    if (agentId && !db.prepare('SELECT 1 FROM agents WHERE id=? AND project_id=?').get(agentId, task.projectId)) throw new Error('Task agent must belong to the same project')
    if (status === 'running' && (!agentId || !sessions.has(agentId))) throw new Error('Start the assigned agent before marking a task as running')
    if (task.approvalStatus === 'pending' && status !== 'blocked') throw new Error('Task is waiting for human approval')
    if ((status === 'assigned' || status === 'backlog') && !dependenciesReady(task.id)) {
      status = 'blocked'
      blockedReason = 'dependencies'
    } else if (status === 'blocked') {
      blockedReason = task.blockedReason === 'approval' ? 'approval' : 'manual'
    } else {
      blockedReason = null
    }
    if (status === 'assigned' && !agentId) status = 'backlog'
    assertTaskTransition(task.status, status)
    if (agentId && agentId !== task.agentId && sessions.has(agentId)) throw new Error('Agent is already running another session')
    const result = input.result === undefined ? (task.status === 'failed' && status !== 'failed' ? null : task.result ?? null) : input.result
    const error = input.error === undefined ? (task.status === 'failed' && status !== 'failed' ? null : task.error ?? null) : input.error
    const branch = input.branch === undefined ? task.branch ?? null : input.branch
    const reviewStatus = input.reviewStatus === undefined ? task.reviewStatus ?? 'pending' : input.reviewStatus
    const reviewNotes = input.reviewNotes === undefined ? task.reviewNotes ?? null : input.reviewNotes
    db.prepare(`UPDATE tasks SET status=?, agent_id=?, result=?, error=?,
      review_status=?, review_notes=?, blocked_reason=?, branch=?, updated_at=CURRENT_TIMESTAMP WHERE id=?`)
      .run(status, agentId, result, error, reviewStatus, reviewNotes, blockedReason, branch, input.id)
    recordEvent(getProject(task.projectId), agentId, 'task.updated', { taskId: input.id, status })
    const mission = db.prepare('SELECT mission_id AS missionId FROM tasks WHERE id=?').get(input.id) as { missionId?: string | null } | undefined
    refreshMissionStatus(mission?.missionId)
    if (status === 'done') promoteDependentTasks(task.projectId)
    return taskRow(input.id)
  })

  ipcMain.handle('tasks:add-artifact', (_event, input: { taskId: string; label: string; kind?: string; location: string; metadata?: Record<string, unknown> }) => {
    const task = db.prepare('SELECT project_id AS projectId FROM tasks WHERE id=?').get(input.taskId) as { projectId: string } | undefined
    const project = task ? getProject(task.projectId) : undefined
    if (!task || !project || typeof input.label !== 'string' || !input.label.trim()) throw new Error('Invalid task artifact')
    const location = validateArtifactLocation(project, input.location)
    const kind = typeof input.kind === 'string' && input.kind.trim() ? input.kind.trim().slice(0, 40) : 'file'
    const artifactId = randomUUID()
    db.prepare('INSERT INTO task_artifacts (id, task_id, label, kind, location, metadata_json) VALUES (?, ?, ?, ?, ?, ?)')
      .run(artifactId, input.taskId, input.label.trim().slice(0, 200), kind, location, JSON.stringify(redactPayload(input.metadata ?? {})))
    recordEvent(getProject(task.projectId), null, 'task.artifact-added', { taskId: input.taskId, artifactId })
    return taskRow(input.taskId)
  })

  ipcMain.handle('tasks:set-review', (_event, input: { taskId: string; status: 'pending' | 'approved' | 'changes_requested'; notes?: string }) => {
    const task = db.prepare('SELECT project_id AS projectId, status FROM tasks WHERE id=?').get(input.taskId) as { projectId: string; status: TaskStatus } | undefined
    if (!task) throw new Error('Task not found')
    const nextTaskStatus: TaskStatus = input.status === 'approved' ? 'done' : input.status === 'changes_requested' ? 'blocked' : 'review'
    assertTaskTransition(task.status, nextTaskStatus)
    db.prepare('UPDATE tasks SET review_status=?, review_notes=?, status=?, blocked_reason=?, updated_at=CURRENT_TIMESTAMP WHERE id=?')
      .run(input.status, input.notes?.trim() || null, nextTaskStatus, nextTaskStatus === 'blocked' ? 'review' : null, input.taskId)
    recordEvent(getProject(task.projectId), null, 'task.reviewed', { taskId: input.taskId, status: input.status })
    const mission = db.prepare('SELECT mission_id AS missionId FROM tasks WHERE id=?').get(input.taskId) as { missionId?: string | null } | undefined
    refreshMissionStatus(mission?.missionId)
    if (nextTaskStatus === 'done') promoteDependentTasks(task.projectId)
    return taskRow(input.taskId)
  })

  ipcMain.handle('missions:list', (_event, projectId?: string) => {
    const project = projectId ?? getActiveProject()?.id
    if (!project) return []
    return db.prepare(`SELECT id, project_id AS projectId, title, request, status, summary,
      created_at AS createdAt, updated_at AS updatedAt FROM missions WHERE project_id=? ORDER BY created_at DESC`).all(project)
  })

  ipcMain.handle('missions:create', (_event, input: { id: string; projectId: string; title?: string; request: string }) => {
    validateIdentifier(input.id, 'Mission id')
    const project = getProject(input.projectId)
    const request = input.request.trim()
    if (!project || !request) throw new Error('Invalid mission')
    const parts = decomposeRequest(request)
    const projectAgents = db.prepare('SELECT id, profile_id AS profileId, status FROM agents WHERE project_id=? ORDER BY status, name').all(project.id) as Array<{ id: string; profileId?: string | null; status: AgentStatus }>
    const missionTitle = input.title?.trim() || parts[0].slice(0, 80)
    const missionId = input.id
    const createdTaskIds: string[] = []
    const transaction = db.transaction(() => {
      db.prepare('INSERT INTO missions (id, project_id, title, request, status) VALUES (?, ?, ?, ?, ?)')
        .run(missionId, project.id, missionTitle, request, 'planned')
      for (const [index, part] of parts.entries()) {
        const profileId = profileForRequest(part)
        const candidate = projectAgents.find(agent => agent.profileId === profileId && agent.status !== 'working')
        const taskId = randomUUID()
        const approvalStatus = requiresApproval(part) ? 'pending' : 'not_required'
        const readiness = resolveTaskReadiness(candidate?.id, true, approvalStatus === 'pending')
        const status = readiness.status
        db.prepare(`INSERT INTO tasks (id, project_id, title, prompt, status, agent_id, mission_id, approval_status, blocked_reason)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(taskId, project.id, `${index + 1}. ${part.slice(0, 100)}`, part, status, candidate?.id ?? null, missionId, approvalStatus, readiness.blockedReason)
        createdTaskIds.push(taskId)
        if (approvalStatus === 'pending') {
          db.prepare(`INSERT INTO approvals (id, project_id, task_id, type, title, reason, payload_json) VALUES (?, ?, ?, ?, ?, ?, ?)`)
            .run(randomUUID(), project.id, taskId, 'safety', `Approve mission task ${index + 1}`, 'Mission step contains a potentially destructive, scope-changing, or costly operation.', JSON.stringify({ missionId, prompt: part }))
        }
      }
    })
    transaction()
    recordEvent(project, null, 'mission.created', { missionId, taskIds: createdTaskIds, taskCount: createdTaskIds.length })
    return {
      mission: db.prepare('SELECT id, project_id AS projectId, title, request, status, created_at AS createdAt FROM missions WHERE id=?').get(missionId),
      tasks: createdTaskIds.map(taskId => taskRow(taskId))
    }
  })

  ipcMain.handle('schedules:list', (_event, projectId?: string) => {
    const project = projectId ?? getActiveProject()?.id
    if (!project) return []
    return db.prepare(`SELECT s.id, s.project_id AS projectId, s.name, s.prompt, s.agent_id AS agentId,
      s.interval_minutes AS intervalMinutes, s.timezone, s.next_run_at AS nextRunAt, s.enabled,
      a.name AS agentName FROM schedules s LEFT JOIN agents a ON a.id=s.agent_id
      WHERE s.project_id=? ORDER BY s.next_run_at`).all(project)
  })

  ipcMain.handle('schedules:create', (_event, input: { id: string; projectId: string; name: string; prompt: string; agentId?: string | null; intervalMinutes: number; timezone?: string; nextRunAt?: string }) => {
    validateIdentifier(input.id, 'Schedule id')
    const project = getProject(input.projectId)
    const intervalMinutes = Math.floor(Number(input.intervalMinutes))
    if (!project || !input.name.trim() || !input.prompt.trim() || !Number.isFinite(intervalMinutes) || intervalMinutes < 1) throw new Error('Invalid schedule')
    if (input.agentId && !db.prepare('SELECT 1 FROM agents WHERE id=? AND project_id=?').get(input.agentId, project.id)) throw new Error('Schedule agent does not belong to project')
    const nextRunAt = input.nextRunAt ? new Date(input.nextRunAt) : new Date(Date.now() + intervalMinutes * 60_000)
    if (Number.isNaN(nextRunAt.getTime())) throw new Error('Invalid next run time')
    db.prepare(`INSERT INTO schedules (id, project_id, name, prompt, agent_id, interval_minutes, timezone, next_run_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(input.id, project.id, input.name.trim(), input.prompt.trim(), input.agentId ?? null, intervalMinutes, input.timezone || 'UTC', nextRunAt.toISOString())
    recordEvent(project, input.agentId ?? null, 'schedule.created', { scheduleId: input.id, intervalMinutes })
    return db.prepare(`SELECT id, project_id AS projectId, name, prompt, agent_id AS agentId, interval_minutes AS intervalMinutes,
      timezone, next_run_at AS nextRunAt, enabled FROM schedules WHERE id=?`).get(input.id)
  })

  ipcMain.handle('schedules:update', (_event, input: { id: string; enabled?: boolean; intervalMinutes?: number; nextRunAt?: string }) => {
    const schedule = db.prepare('SELECT project_id AS projectId, interval_minutes AS intervalMinutes, next_run_at AS nextRunAt FROM schedules WHERE id=?').get(input.id) as { projectId: string; intervalMinutes: number; nextRunAt: string } | undefined
    if (!schedule) throw new Error('Schedule not found')
    const intervalMinutes = input.intervalMinutes === undefined ? schedule.intervalMinutes : Math.floor(Number(input.intervalMinutes))
    if (!Number.isFinite(intervalMinutes) || intervalMinutes < 1) throw new Error('Interval must be at least one minute')
    const nextRunAt = input.nextRunAt ? new Date(input.nextRunAt) : new Date(schedule.nextRunAt)
    if (Number.isNaN(nextRunAt.getTime())) throw new Error('Invalid next run time')
    db.prepare('UPDATE schedules SET enabled=COALESCE(?, enabled), interval_minutes=?, next_run_at=?, updated_at=CURRENT_TIMESTAMP WHERE id=?')
      .run(input.enabled === undefined ? null : input.enabled ? 1 : 0, intervalMinutes, nextRunAt.toISOString(), input.id)
    recordEvent(getProject(schedule.projectId), null, 'schedule.updated', { scheduleId: input.id })
    return db.prepare(`SELECT id, project_id AS projectId, name, prompt, agent_id AS agentId, interval_minutes AS intervalMinutes,
      timezone, next_run_at AS nextRunAt, enabled FROM schedules WHERE id=?`).get(input.id)
  })

  ipcMain.handle('schedules:remove', (_event, id: string) => {
    const schedule = db.prepare('SELECT project_id AS projectId FROM schedules WHERE id=?').get(id) as { projectId: string } | undefined
    if (!schedule) return false
    db.prepare('DELETE FROM schedules WHERE id=?').run(id)
    recordEvent(getProject(schedule.projectId), null, 'schedule.removed', { scheduleId: id })
    return true
  })

  ipcMain.handle('approvals:list', (_event, projectId?: string) => {
    const project = projectId ?? getActiveProject()?.id
    if (!project) return []
    return db.prepare(`SELECT a.id, a.project_id AS projectId, a.task_id AS taskId, a.type, a.title, a.reason,
      a.payload_json AS payloadJson, a.status, a.created_at AS createdAt, a.resolved_at AS resolvedAt,
      t.title AS taskTitle FROM approvals a LEFT JOIN tasks t ON t.id=a.task_id
      WHERE a.project_id=? ORDER BY CASE a.status WHEN 'pending' THEN 0 ELSE 1 END, a.created_at DESC`).all(project)
  })

  ipcMain.handle('approvals:resolve', (_event, input: { id: string; status: 'approved' | 'rejected' }) => {
    const approval = db.prepare('SELECT project_id AS projectId, task_id AS taskId, type FROM approvals WHERE id=? AND status=?').get(input.id, 'pending') as { projectId: string; taskId?: string | null; type: string } | undefined
    if (!approval) throw new Error('Pending approval not found')
    const transaction = db.transaction(() => {
      db.prepare("UPDATE approvals SET status=?, resolved_at=CURRENT_TIMESTAMP WHERE id=?").run(input.status, input.id)
      if (approval.taskId) {
        const task = db.prepare('SELECT agent_id AS agentId, status FROM tasks WHERE id=?').get(approval.taskId) as { agentId?: string | null; status: TaskStatus } | undefined
        if (task && input.status === 'approved') {
          const nextStatus = resolveTaskReadiness(task.agentId, dependenciesReady(approval.taskId), false).status
          assertTaskTransition(task.status, nextStatus)
          db.prepare("UPDATE tasks SET approval_status='approved', status=?, blocked_reason=?, updated_at=CURRENT_TIMESTAMP WHERE id=?")
            .run(nextStatus, nextStatus === 'blocked' ? 'dependencies' : null, approval.taskId)
        } else if (task) {
          db.prepare("UPDATE tasks SET approval_status='rejected', status='blocked', blocked_reason='approval', updated_at=CURRENT_TIMESTAMP WHERE id=?")
            .run(approval.taskId)
        }
      }
      if (input.status === 'rejected' && approval.type === 'config-change') {
        const project = getProject(approval.projectId)
        if (project) fs.rmSync(join(ensureProjectWorkspace(project), 'pending-config', `${input.id}.json`), { force: true })
      }
    })
    transaction()
    recordEvent(getProject(approval.projectId), null, 'approval.resolved', { approvalId: input.id, taskId: approval.taskId, status: input.status })
    return true
  })

  ipcMain.handle('config:prepare', (_event, input: { projectId: string; path: string; content: string }) => {
    const project = getProject(input.projectId)
    if (!project || typeof input.path !== 'string' || typeof input.content !== 'string') throw new Error('Invalid config change')
    const configPath = validateConfigPath(project, input.path)
    const current = fs.existsSync(configPath) ? fs.readFileSync(configPath, 'utf8') : ''
    const diff = unifiedDiff(current, input.content)
    if (diff === '(no changes)') throw new Error('Config has no changes')
    const approvalId = randomUUID()
    const pendingPath = join(ensureProjectWorkspace(project), 'pending-config', `${approvalId}.json`)
    writeJsonAtomic(pendingPath, { projectId: project.id, path: configPath, content: input.content, createdAt: new Date().toISOString() })
    fs.chmodSync(pendingPath, 0o600)
    db.prepare(`INSERT INTO approvals (id, project_id, type, title, reason, payload_json) VALUES (?, ?, 'config-change', ?, ?, ?)`)
      .run(approvalId, project.id, `Approve CLI config change: ${basename(configPath)}`, 'The existing file will be backed up before an atomic replacement.', JSON.stringify({ path: configPath, diff }))
    recordEvent(project, null, 'config.change-prepared', { approvalId, path: configPath, diff })
    return { approvalId, path: configPath, diff }
  })

  ipcMain.handle('config:apply', (_event, approvalId: string) => {
    const approval = db.prepare("SELECT id, project_id AS projectId, payload_json AS payloadJson FROM approvals WHERE id=? AND type='config-change' AND status='approved'").get(approvalId) as { id: string; projectId: string; payloadJson: string } | undefined
    if (!approval) throw new Error('An approved config change is required')
    const project = getProject(approval.projectId)
    const pendingPath = project ? join(ensureProjectWorkspace(project), 'pending-config', `${approvalId}.json`) : ''
    if (!project || !fs.existsSync(pendingPath)) throw new Error('Pending config change is missing or expired')
    const pending = JSON.parse(fs.readFileSync(pendingPath, 'utf8')) as { projectId?: string; path: string; content: string }
    const approvedDetails = JSON.parse(approval.payloadJson) as { path?: string }
    if (pending.projectId !== approval.projectId || !approvedDetails.path || resolve(pending.path) !== resolve(approvedDetails.path)) throw new Error('Pending config does not match the approved diff')
    const configPath = validateConfigPath(project, pending.path)
    const current = fs.existsSync(configPath) ? fs.readFileSync(configPath, 'utf8') : ''
    const backupPath = fs.existsSync(configPath) ? `${configPath}.agent-office.bak-${Date.now()}` : null
    if (backupPath) fs.copyFileSync(configPath, backupPath)
    writeTextAtomic(`${configPath}.agent-office`, pending.content)
    if (fs.existsSync(configPath)) fs.rmSync(configPath)
    fs.renameSync(`${configPath}.agent-office`, configPath)
    fs.rmSync(pendingPath, { force: true })
    recordEvent(project, null, 'config.change-applied', { approvalId, path: configPath, backupPath, diff: unifiedDiff(current, pending.content) })
    return { path: configPath, backupPath }
  })

  ipcMain.handle('github:status', (_event, projectId?: string) => {
    const project = getProject(projectId ?? getActiveProject()?.id ?? '')
    if (!project) return { installed: false, authenticated: false }
    try {
      gh(project.path, ['auth', 'status'])
      return { installed: true, authenticated: true }
    } catch {
      try { execFileSync('gh', ['--version'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }); return { installed: true, authenticated: false } } catch { return { installed: false, authenticated: false } }
    }
  })

  ipcMain.handle('github:import-issues', (_event, projectId?: string) => {
    const project = getProject(projectId ?? getActiveProject()?.id ?? '')
    if (!project) throw new Error('Project not found')
    let issues: Array<{ number: number; title: string; body?: string; url?: string; state: string; labels?: Array<{ name: string }> }>
    try {
      issues = JSON.parse(gh(project.path, ['issue', 'list', '--state', 'all', '--limit', '50', '--json', 'number,title,body,url,state,labels'])) as typeof issues
    } catch (error) {
      throw new Error(`Unable to import GitHub issues: ${error instanceof Error ? error.message : 'gh is unavailable or not authenticated'}`)
    }
    const imported: Array<{ issueNumber: number; taskId: string; created: boolean }> = []
    for (const issue of issues) {
      if (!Number.isInteger(issue.number) || !issue.title?.trim()) continue
      const body = redactSecrets(issue.body?.trim() ?? '')
      const existing = db.prepare('SELECT id, task_id AS taskId FROM github_issues WHERE project_id=? AND issue_number=?').get(project.id, issue.number) as { id: string; taskId?: string | null } | undefined
      if (existing) {
        db.prepare('UPDATE github_issues SET title=?, body=?, url=?, state=?, labels_json=?, synced_at=CURRENT_TIMESTAMP WHERE id=?')
          .run(issue.title.trim(), body, issue.url ?? null, issue.state, JSON.stringify((issue.labels ?? []).map(label => label.name)), existing.id)
        if (existing.taskId) db.prepare('UPDATE tasks SET title=?, prompt=?, updated_at=CURRENT_TIMESTAMP WHERE id=?').run(`GitHub #${issue.number}: ${issue.title.trim()}`, body || issue.title.trim(), existing.taskId)
        imported.push({ issueNumber: issue.number, taskId: existing.taskId ?? '', created: false })
        continue
      }
      const candidate = db.prepare("SELECT id FROM agents WHERE project_id=? AND profile_id='developer' AND status!='working' ORDER BY status, name LIMIT 1").get(project.id) as { id: string } | undefined
      const taskId = randomUUID()
      const prompt = body || issue.title.trim()
      const approvalStatus = requiresApproval(prompt) ? 'pending' : 'not_required'
      const status: TaskStatus = approvalStatus === 'pending' ? 'blocked' : candidate ? 'assigned' : 'backlog'
      const transaction = db.transaction(() => {
        db.prepare(`INSERT INTO tasks (id, project_id, title, prompt, status, agent_id, approval_status, source_type, source_ref)
          VALUES (?, ?, ?, ?, ?, ?, ?, 'github-issue', ?)`)
          .run(taskId, project.id, `GitHub #${issue.number}: ${issue.title.trim()}`, prompt, status, candidate?.id ?? null, approvalStatus, String(issue.number))
        db.prepare(`INSERT INTO github_issues (id, project_id, issue_number, title, body, url, state, labels_json, task_id)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(randomUUID(), project.id, issue.number, issue.title.trim(), body, issue.url ?? null, issue.state, JSON.stringify((issue.labels ?? []).map(label => label.name)), taskId)
        if (approvalStatus === 'pending') db.prepare(`INSERT INTO approvals (id, project_id, task_id, type, title, reason, payload_json) VALUES (?, ?, ?, 'safety', ?, ?, ?)`)
          .run(randomUUID(), project.id, taskId, `Approve GitHub issue #${issue.number}`, 'Issue body contains a potentially destructive, scope-changing, or costly operation.', JSON.stringify({ issueNumber: issue.number }))
      })
      transaction()
      recordEvent(project, candidate?.id ?? null, 'github.issue-imported', { issueNumber: issue.number, taskId })
      imported.push({ issueNumber: issue.number, taskId, created: true })
    }
    return imported
  })

  ipcMain.handle('github:prepare-pr', (_event, input: { taskId: string; title?: string; body?: string }) => {
    const task = db.prepare('SELECT id, project_id AS projectId, title, prompt, status, result, agent_id AS agentId, source_ref AS sourceRef FROM tasks WHERE id=?').get(input.taskId) as { id: string; projectId: string; title: string; prompt: string; status: TaskStatus; result?: string | null; agentId?: string | null; sourceRef?: string | null } | undefined
    if (!task || !task.agentId) throw new Error('Task must have an assigned agent before preparing a PR')
    if (!['review', 'done'].includes(task.status)) throw new Error('Task must reach review before preparing a PR')
    const agent = db.prepare('SELECT worktree_path AS worktreePath, branch, profile_id AS profileId FROM agents WHERE id=?').get(task.agentId) as { worktreePath?: string | null; branch?: string | null; profileId?: string | null } | undefined
    const project = getProject(task.projectId)
    if (!project || !agent?.worktreePath || !agent.branch) throw new Error('Task agent has no isolated branch')
    if (!profilePermissions(agent.profileId).git || !profilePermissions(agent.profileId).network) throw new Error('Agent profile does not allow GitHub operations')
    if (git(agent.worktreePath, ['status', '--porcelain'])) throw new Error('Commit or stash all worktree changes before preparing a PR')
    const preflight = gitPreflight(agent.worktreePath, project.defaultBranch, agent.branch)
    if (!preflight.ok) {
      recordEvent(project, task.agentId, 'github.pr-blocked', { taskId: task.id, reason: preflight.reason, detail: preflight.detail })
      throw new Error(`Cannot prepare PR: ${preflight.reason}`)
    }
    let diffStat = ''
    try { diffStat = git(agent.worktreePath, ['diff', '--stat', `${project.defaultBranch}...${agent.branch}`]) } catch { diffStat = git(agent.worktreePath, ['status', '--short']) }
    const approvalId = randomUUID()
    const testSummary = task.result?.trim() || 'No recorded task output; attach test results before merging.'
    const payload = { taskId: task.id, agentId: task.agentId, projectId: project.id, baseBranch: project.defaultBranch, headBranch: agent.branch, title: input.title?.trim() || task.title, body: input.body?.trim() || `Closes #${task.sourceRef ?? ''}\n\n${task.prompt}\n\nDiff summary:\n${diffStat}\n\nTest/result summary:\n${testSummary}`, preflightCheckedAt: new Date().toISOString() }
    db.prepare(`INSERT INTO approvals (id, project_id, task_id, type, title, reason, payload_json) VALUES (?, ?, ?, 'github-pr', ?, ?, ?)`)
      .run(approvalId, project.id, task.id, `Approve pull request: ${payload.title}`, 'Creating a pull request may push a branch and changes external GitHub state.', JSON.stringify({ ...payload, diffStat }))
    recordEvent(project, task.agentId, 'github.pr-prepared', { approvalId, taskId: task.id, diffStat })
    return { approvalId, diffStat }
  })

  ipcMain.handle('github:create-pr', (_event, approvalId: string) => {
    const approval = db.prepare("SELECT project_id AS projectId, task_id AS taskId, payload_json AS payloadJson FROM approvals WHERE id=? AND type='github-pr' AND status='approved'").get(approvalId) as { projectId: string; taskId: string; payloadJson: string } | undefined
    if (!approval) throw new Error('An approved GitHub PR request is required')
    const payload = JSON.parse(approval.payloadJson) as { agentId: string; projectId: string; baseBranch: string; headBranch: string; title: string; body: string }
    const agent = db.prepare('SELECT worktree_path AS worktreePath, profile_id AS profileId, branch FROM agents WHERE id=? AND project_id=?').get(payload.agentId, payload.projectId) as { worktreePath?: string | null; profileId?: string | null; branch?: string | null } | undefined
    const project = getProject(payload.projectId)
    if (!project || !agent?.worktreePath || agent.branch !== payload.headBranch) throw new Error('Agent branch is no longer available')
    const permissions = profilePermissions(agent.profileId)
    if (!permissions.git || !permissions.network) throw new Error('Agent profile does not allow GitHub operations')
    if (git(agent.worktreePath, ['status', '--porcelain'])) throw new Error('Branch has uncommitted changes; PR creation stopped')
    const preflight = gitPreflight(agent.worktreePath, payload.baseBranch, payload.headBranch)
    if (!preflight.ok) throw new Error(`Branch changed after approval: ${preflight.reason}`)
    const url = gh(agent.worktreePath, ['pr', 'create', '--base', payload.baseBranch, '--head', payload.headBranch, '--title', payload.title, '--body', payload.body])
    db.prepare('INSERT INTO task_artifacts (id, task_id, label, kind, location, metadata_json) VALUES (?, ?, ?, ?, ?, ?)')
      .run(randomUUID(), approval.taskId, 'Pull request', 'github-pr', url, JSON.stringify({ approvalId }))
    recordEvent(project, payload.agentId, 'github.pr-created', { taskId: approval.taskId, url })
    return { url: redactSecrets(url) }
  })

  ipcMain.handle('fleet:summary', (_event, projectId?: string) => {
    const project = projectId ?? getActiveProject()?.id
    if (!project) return null
    const agents = db.prepare(`SELECT COUNT(*) AS total, SUM(status='working') AS working, SUM(status='paused') AS paused,
      SUM(status='error') AS errors FROM agents WHERE project_id=?`).get(project) as Record<string, number>
    const tasks = db.prepare(`SELECT COUNT(*) AS total, SUM(status IN ('backlog','assigned')) AS queued,
      SUM(status='running') AS running, SUM(status='failed') AS errors FROM tasks WHERE project_id=?`).get(project) as Record<string, number>
    const approvals = db.prepare("SELECT COUNT(*) AS pending FROM approvals WHERE project_id=? AND status='pending'").get(project) as { pending: number }
    const usage = db.prepare('SELECT COALESCE(SUM(duration_ms), 0) AS durationMs, COALESCE(SUM(output_bytes), 0) AS outputBytes FROM execution_usage u JOIN tasks t ON t.id=u.task_id WHERE t.project_id=?').get(project) as { durationMs: number; outputBytes: number }
    return { agents, tasks, approvals, usage }
  })

  ipcMain.handle('messages:list', (_event, projectId?: string) => {
    const project = projectId ?? getActiveProject()?.id
    if (!project) return []
    return db.prepare(`
      SELECT m.message_id AS id, m.project_id AS projectId, m.from_agent AS fromAgent,
        m.to_agent AS toAgent, m.body, m.status, m.attempts, m.last_error AS lastError, m.created_at AS createdAt,
        sender.name AS fromName, recipient.name AS toName
      FROM messages m
      LEFT JOIN agents sender ON sender.id=m.from_agent
      LEFT JOIN agents recipient ON recipient.id=m.to_agent
      WHERE m.project_id=? ORDER BY m.created_at DESC LIMIT 100
    `).all(project)
  })

  ipcMain.handle('messages:send', (_event, input: { projectId: string; fromAgent: string; toAgent: string; body: string }) => {
    const project = getProject(input.projectId)
    const recipient = db.prepare('SELECT id FROM agents WHERE id=? AND project_id=?').get(input.toAgent, input.projectId)
    const sender = db.prepare('SELECT id FROM agents WHERE id=? AND project_id=?').get(input.fromAgent, input.projectId)
    if (!project || !sender || !recipient || !input.body.trim()) throw new Error('Invalid mailbox participants or empty message')
    const id = randomUUID()
    const message = { id, projectId: project.id, fromAgent: input.fromAgent, toAgent: input.toAgent, body: redactSecrets(input.body.trim()), createdAt: new Date().toISOString() }
    const root = ensureProjectWorkspace(project)
    writeJsonAtomic(join(root, 'outbox', `${id}.json`), message)
    db.prepare('INSERT INTO messages (message_id, project_id, from_agent, to_agent, body, status) VALUES (?, ?, ?, ?, ?, ?)')
      .run(id, project.id, input.fromAgent, input.toAgent, message.body, 'pending')
    recordEvent(project, input.fromAgent, 'message.sent', { messageId: id, toAgent: input.toAgent })
    return { ...message, status: 'pending' }
  })

  ipcMain.handle('messages:ack', (_event, input: { projectId: string; agentId: string; messageId: string }) => {
    const message = db.prepare('SELECT to_agent AS toAgent FROM messages WHERE message_id=? AND project_id=?').get(input.messageId, input.projectId) as { toAgent: string } | undefined
    if (!message || message.toAgent !== input.agentId) throw new Error('Message recipient does not match acknowledgement agent')
    const root = ensureProjectWorkspace(getProject(input.projectId)!)
    fs.rmSync(join(root, 'inbox', `${input.agentId}-${input.messageId}.json`), { force: true })
    db.prepare("UPDATE messages SET status='read' WHERE message_id=?").run(input.messageId)
    recordEvent(getProject(input.projectId), input.agentId, 'message.acknowledged', { messageId: input.messageId })
    return true
  })

  ipcMain.handle('events:list', (_event, projectId?: string) => {
    const project = projectId ?? getActiveProject()?.id
    if (!project) return []
    return (db.prepare('SELECT id, project_id AS projectId, agent_id AS agentId, type, payload_json AS payloadJson, created_at AS createdAt FROM events WHERE project_id=? ORDER BY created_at DESC LIMIT 100').all(project) as Array<{ payloadJson: string } & Record<string, unknown>>)
      .map(event => ({ ...event, payload: JSON.parse(event.payloadJson), payloadJson: undefined }))
  })

  ipcMain.handle('memories:list', (_event, input?: { projectId?: string; query?: string }) => {
    const project = input?.projectId ?? getActiveProject()?.id
    if (!project) return []
    const query = input?.query?.trim() ?? ''
    if (query) {
      const ftsQuery = query.replace(/[^\p{L}\p{N}_-]+/gu, ' ').trim().split(/\s+/).filter(Boolean).map(token => `${token}*`).join(' AND ')
      try {
        return db.prepare(`
          SELECT m.id, m.project_id AS projectId, m.agent_id AS agentId, m.title,
            m.category, m.body, m.file_path AS filePath, m.created_at AS createdAt,
            m.updated_at AS updatedAt, m.pinned, m.retention_days AS retentionDays, a.name AS agentName
          FROM memories m JOIN memories_fts f ON f.memory_id=m.id
          LEFT JOIN agents a ON a.id=m.agent_id
          WHERE m.project_id=? AND memories_fts MATCH ? ORDER BY m.updated_at DESC
        `).all(project, ftsQuery)
      } catch { /* SQLite build tanpa FTS5 memakai pencarian LIKE */ }
    }
    return db.prepare(`
      SELECT m.id, m.project_id AS projectId, m.agent_id AS agentId, m.title,
        m.category, m.body, m.file_path AS filePath, m.created_at AS createdAt,
        m.updated_at AS updatedAt, m.pinned, m.retention_days AS retentionDays, a.name AS agentName
      FROM memories m LEFT JOIN agents a ON a.id=m.agent_id
      WHERE m.project_id=? AND (?='' OR m.title LIKE ? OR m.body LIKE ? OR m.category LIKE ?)
      ORDER BY m.updated_at DESC
    `).all(project, query, `%${query}%`, `%${query}%`, `%${query}%`)
  })

  ipcMain.handle('memories:semantic-search', (_event, input: { projectId?: string; query: string }) => {
    const project = input.projectId ?? getActiveProject()?.id
    const query = input.query.trim()
    if (!project || !query) return []
    const queryVector = memoryVector(query)
    const rows = db.prepare(`SELECT m.id, m.project_id AS projectId, m.agent_id AS agentId, m.title, m.category,
      m.body, m.file_path AS filePath, m.pinned, m.retention_days AS retentionDays,
      m.created_at AS createdAt, m.updated_at AS updatedAt, v.vector_json AS vectorJson, a.name AS agentName
      FROM memories m JOIN memory_vectors v ON v.memory_id=m.id LEFT JOIN agents a ON a.id=m.agent_id WHERE m.project_id=?`).all(project) as Array<{ vectorJson: string } & Record<string, unknown>>
    return rows.map(row => ({ ...row, score: vectorSimilarity(queryVector, JSON.parse(row.vectorJson)), vectorJson: undefined }))
      .filter(row => row.score > 0).sort((left, right) => right.score - left.score).slice(0, 50)
  })

  ipcMain.handle('memories:save', (_event, input: { id?: string; projectId: string; agentId?: string | null; title: string; category: string; body: string; pinned?: boolean; retentionDays?: number | null }) => {
    const project = getProject(input.projectId)
    if (!project || !input.title.trim() || !input.body.trim()) throw new Error('Invalid memory')
    const id = input.id ?? randomUUID()
    validateIdentifier(id, 'Memory id')
    const root = ensureProjectWorkspace(project)
    const filePath = join(root, 'memory', `${id}.md`)
    const body = redactSecrets(input.body.trim())
    const markdown = `---\ntitle: ${input.title.trim()}\ncategory: ${input.category.trim() || 'general'}\nagent: ${input.agentId ?? ''}\n---\n\n${body}\n`
    writeJsonAtomic(`${filePath}.metadata`, { id, title: input.title.trim(), category: input.category.trim() || 'general' })
    fs.writeFileSync(`${filePath}.tmp`, markdown, 'utf8')
    fs.renameSync(`${filePath}.tmp`, filePath)
    const retentionDays = input.retentionDays == null ? null : Math.floor(Number(input.retentionDays))
    if (retentionDays !== null && (!Number.isFinite(retentionDays) || retentionDays < 1)) throw new Error('Retention must be at least one day')
    db.prepare(`INSERT INTO memories (id, project_id, agent_id, title, category, body, file_path, pinned, retention_days)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET agent_id=excluded.agent_id, title=excluded.title,
      category=excluded.category, body=excluded.body, file_path=excluded.file_path, pinned=excluded.pinned,
      retention_days=excluded.retention_days, updated_at=CURRENT_TIMESTAMP`)
      .run(id, project.id, input.agentId ?? null, input.title.trim(), input.category.trim() || 'general', body, filePath, input.pinned ? 1 : 0, retentionDays)
    try {
      db.prepare('DELETE FROM memories_fts WHERE memory_id=?').run(id)
      db.prepare('INSERT INTO memories_fts (memory_id, title, category, body) VALUES (?, ?, ?, ?)')
        .run(id, input.title.trim(), input.category.trim() || 'general', body)
    } catch { /* SQLite build tanpa FTS5 memakai pencarian LIKE */ }
    db.prepare(`INSERT INTO memory_vectors (memory_id, vector_json) VALUES (?, ?)
      ON CONFLICT(memory_id) DO UPDATE SET vector_json=excluded.vector_json, updated_at=CURRENT_TIMESTAMP`)
      .run(id, JSON.stringify(memoryVector(`${input.title} ${input.category} ${body}`)))
    recordEvent(project, input.agentId ?? null, 'memory.saved', { memoryId: id, category: input.category.trim() || 'general' })
    return db.prepare('SELECT id, project_id AS projectId, agent_id AS agentId, title, category, body, file_path AS filePath, pinned, retention_days AS retentionDays, created_at AS createdAt, updated_at AS updatedAt FROM memories WHERE id=?').get(id)
  })

  ipcMain.handle('memories:remove', (_event, id: string) => {
    const memory = db.prepare('SELECT project_id AS projectId, file_path AS filePath FROM memories WHERE id=?').get(id) as { projectId: string; filePath: string } | undefined
    if (!memory) return false
    const project = getProject(memory.projectId)
    if (!project) throw new Error('Memory project not found')
    validateMemoryPath(project, memory.filePath)
    fs.rmSync(memory.filePath, { force: true })
    fs.rmSync(`${memory.filePath}.metadata`, { force: true })
    db.prepare('DELETE FROM memories WHERE id=?').run(id)
    recordEvent(project, null, 'memory.removed', { memoryId: id })
    return true
  })

  ipcMain.handle('memories:pin', (_event, input: { id: string; pinned: boolean }) => {
    const memory = db.prepare('SELECT project_id AS projectId FROM memories WHERE id=?').get(input.id) as { projectId: string } | undefined
    if (!memory) throw new Error('Memory not found')
    db.prepare('UPDATE memories SET pinned=?, updated_at=CURRENT_TIMESTAMP WHERE id=?').run(input.pinned ? 1 : 0, input.id)
    recordEvent(getProject(memory.projectId), null, 'memory.pinned', { memoryId: input.id, pinned: input.pinned })
    return true
  })

  ipcMain.handle('memories:prune', (_event, projectId?: string) => {
    return pruneExpiredMemories(projectId ?? getActiveProject()?.id)
  })

  ipcMain.handle('profiles:list', () => {
    return (db.prepare('SELECT id, name, role, command, soul, permissions_json AS permissionsJson, built_in AS builtIn FROM profiles ORDER BY built_in DESC, name').all() as Array<{ permissionsJson: string } & Record<string, unknown>>)
      .map(profile => ({ ...profile, permissions: parsePermissions(profile.permissionsJson), permissionsJson: undefined }))
  })

  ipcMain.handle('profiles:create', (_event, input: Omit<AgentProfile, 'builtIn'>) => {
    validateIdentifier(input.id, 'Profile id')
    const command = validateCommand(input.command)
    const permissions = normalizePermissions(input.permissions)
    db.prepare('INSERT INTO profiles (id, name, role, command, soul, permissions_json, built_in) VALUES (?, ?, ?, ?, ?, ?, 0)')
      .run(input.id, input.name.trim(), input.role.trim(), command, input.soul.trim(), JSON.stringify(permissions))
    return { ...input, name: input.name.trim(), role: input.role.trim(), command, soul: input.soul.trim(), permissions, builtIn: 0 }
  })

  ipcMain.handle('profiles:update', (_event, input: Omit<AgentProfile, 'builtIn'>) => {
    validateIdentifier(input.id, 'Profile id')
    const command = validateCommand(input.command)
    const permissions = normalizePermissions(input.permissions)
    db.prepare('UPDATE profiles SET name=?, role=?, command=?, soul=?, permissions_json=? WHERE id=? AND built_in=0')
      .run(input.name.trim(), input.role.trim(), command, input.soul.trim(), JSON.stringify(permissions), input.id)
    db.prepare('UPDATE agents SET name=?, role=?, command=? WHERE profile_id=?')
      .run(input.name.trim(), input.role.trim(), command, input.id)
    const profile = db.prepare('SELECT id, name, role, command, soul, permissions_json AS permissionsJson, built_in AS builtIn FROM profiles WHERE id=?').get(input.id) as { permissionsJson: string } & Record<string, unknown>
    return { ...profile, permissions: parsePermissions(profile.permissionsJson), permissionsJson: undefined }
  })

  ipcMain.handle('profiles:remove', (_event, id: string) => {
    const profile = db.prepare('SELECT built_in AS builtIn FROM profiles WHERE id=?').get(id) as { builtIn: number } | undefined
    if (!profile || profile.builtIn) return false
    db.prepare('UPDATE agents SET profile_id=NULL WHERE profile_id=?').run(id)
    db.prepare('DELETE FROM profiles WHERE id=?').run(id)
    return true
  })

  ipcMain.handle('agents:list', () => {
    const agents = db.prepare(`
      SELECT a.id, a.name, a.command,
        CASE WHEN a.cwd='.' THEN COALESCE(project.path, a.cwd) ELSE a.cwd END AS cwd,
        a.role, a.project_id AS projectId, a.worktree_path AS worktreePath, a.branch,
        a.profile_id AS profileId, a.status, p.name AS profileName, p.soul,
        project.name AS projectName
      FROM agents a
      LEFT JOIN profiles p ON p.id = a.profile_id
      LEFT JOIN projects project ON project.id = a.project_id
      ORDER BY a.name
    `).all()
    return (agents as Array<Agent>).map(agent => ({
      ...agent,
      dirty: (() => {
        try { return Boolean(git(agent.worktreePath || agent.cwd, ['status', '--porcelain'])) } catch { return false }
      })()
    }))
  })

  ipcMain.handle('agents:create', (_event, input: Omit<Agent, 'status'>) => {
    validateIdentifier(input.id, 'Agent id')
    const requestedCommand = validateCommand(input.command)
    const project = input.projectId ? getProject(input.projectId) : getActiveProject()
    const profile = input.profileId
      ? db.prepare('SELECT role, command FROM profiles WHERE id=?').get(input.profileId) as { role: string; command: string } | undefined
      : undefined
    if (input.profileId && !profile) throw new Error('Profile not found')
    const role = profile?.role ?? input.role
    const command = profile?.command ?? requestedCommand
    const workspace = project ? createWorktree(project, input.id) : { cwd: input.cwd || os.homedir(), worktreePath: null, branch: null }
    try {
      db.prepare(`INSERT INTO agents (id,name,command,cwd,role,project_id,worktree_path,branch,profile_id,status) VALUES (@id,@name,@command,@cwd,@role,@projectId,@worktreePath,@branch,@profileId,'idle')`)
        .run({ ...input, role, command, cwd: workspace.cwd, projectId: project?.id ?? null, worktreePath: workspace.worktreePath, branch: workspace.branch, profileId: input.profileId ?? null })
    } catch (error) {
      removeWorktree(project, workspace.worktreePath)
      throw error
    }
    return { ...input, role, command, cwd: workspace.cwd, projectId: project?.id ?? null, worktreePath: workspace.worktreePath, branch: workspace.branch, profileId: input.profileId ?? null, status: 'idle' }
  })

  ipcMain.handle('agents:remove', (_event, id: string) => {
    const agent = db.prepare('SELECT project_id AS projectId, worktree_path AS worktreePath FROM agents WHERE id=?').get(id) as { projectId?: string; worktreePath?: string } | undefined
    sessions.get(id)?.kill()
    sessions.delete(id)
    db.prepare('DELETE FROM commit_locks WHERE agent_id=?').run(id)
    db.prepare('DELETE FROM agents WHERE id = ?').run(id)
    removeWorktree(agent?.projectId ? getProject(agent.projectId) : undefined, agent?.worktreePath)
    return true
  })

  ipcMain.handle('agent:start', (event, agent: Agent & { taskId?: string; taskPrompt?: string }) => {
    if (!agent || typeof agent.id !== 'string') throw new Error('Invalid agent start request')
    const storedAgent = db.prepare(`
      SELECT id, name, command, cwd, role, project_id AS projectId,
        worktree_path AS worktreePath, branch, profile_id AS profileId, status
      FROM agents WHERE id=?
    `).get(agent.id) as Agent | undefined
    if (!storedAgent) throw new Error('Agent not found')
    const taskId = typeof agent.taskId === 'string' ? agent.taskId : undefined
    if (sessions.has(storedAgent.id)) {
      if (taskId) throw new Error('Agent already has an active session')
      return true
    }
    const command = validateCommand(storedAgent.command)
    const shell = terminalShell(command)
    const profile = storedAgent.profileId
      ? db.prepare('SELECT name, soul FROM profiles WHERE id=?').get(storedAgent.profileId) as { name: string; soul: string } | undefined
      : undefined
    const permissions = profilePermissions(storedAgent.profileId)
    if (!permissions.shell) throw new Error('Agent profile does not allow shell execution')
    const project = storedAgent.projectId ? getProject(storedAgent.projectId) : undefined
    if (storedAgent.projectId && !project) throw new Error('Agent project not found')
    const cwd = resolve(storedAgent.worktreePath || (project && storedAgent.cwd === '.' ? project.path : storedAgent.cwd) || project?.path || os.homedir())
    if (!isDirectory(cwd)) throw new Error('Agent workspace does not exist or is not a directory')
    if (project) {
      const worktreeRoot = join(app.getPath('userData'), 'worktrees', safePathSegment(project.id))
      if (!isCanonicalPathInside(project.path, cwd) && !isCanonicalPathInside(worktreeRoot, cwd)) {
        throw new Error('Agent workspace is outside the project or its worktree directory')
      }
    }
    let taskPrompt = ''
    if (taskId) {
      const task = db.prepare('SELECT status, approval_status AS approvalStatus, budget_minutes AS budgetMinutes, blocked_reason AS blockedReason, prompt FROM tasks WHERE id=? AND agent_id=?').get(taskId, storedAgent.id) as { status: TaskStatus; approvalStatus: string; budgetMinutes?: number | null; blockedReason?: string | null; prompt: string } | undefined
      if (!task) throw new Error('Task is not assigned to this agent')
      taskPrompt = task.prompt
      if (task.status === 'running' || taskRuns.has(taskId)) throw new Error('Task is already running')
      if (!['backlog', 'assigned', 'blocked', 'failed'].includes(task.status)) throw new Error(`Task cannot be started from ${task.status}`)
      if (task.approvalStatus === 'pending') throw new Error('Task is waiting for human approval')
      if (task.approvalStatus === 'rejected') throw new Error('Task approval was rejected')
      if (task.blockedReason === 'manual') throw new Error('Task is manually blocked')
      if (!dependenciesReady(taskId)) {
        db.prepare("UPDATE tasks SET status='blocked', blocked_reason='dependencies', updated_at=CURRENT_TIMESTAMP WHERE id=?").run(taskId)
        recordEvent(project, storedAgent.id, 'task.blocked', { taskId, reason: 'dependencies' })
        throw new Error('Task dependencies are not complete')
      }
      assertTaskTransition(task.status, 'running')
      db.prepare("UPDATE tasks SET status='running', blocked_reason=NULL, updated_at=CURRENT_TIMESTAMP WHERE id=?").run(taskId)
      const runId = randomUUID()
      taskRuns.set(taskId, { id: runId, startedAt: Date.now() })
      db.prepare('INSERT INTO execution_usage (id, task_id, agent_id, started_at) VALUES (?, ?, ?, ?)')
        .run(runId, taskId, storedAgent.id, new Date().toISOString())
      if (task.budgetMinutes && task.budgetMinutes > 0) {
        const timeout = setTimeout(() => {
          if (!sessions.has(storedAgent.id)) return
          recordEvent(project, storedAgent.id, 'task.budget-exceeded', { taskId, budgetMinutes: task.budgetMinutes })
          sessions.get(storedAgent.id)?.kill()
        }, task.budgetMinutes * 60_000)
        taskTimeouts.set(taskId, timeout)
      }
      recordEvent(project, storedAgent.id, 'task.started', { taskId })
    }
    const environment = { ...process.env } as Record<string, string>
    if (!permissions.secrets) {
      for (const key of Object.keys(environment)) {
        if (/(?:TOKEN|KEY|SECRET|PASSWORD|CREDENTIAL)/i.test(key)) delete environment[key]
      }
    }
    environment.AGENT_OFFICE_NETWORK_ALLOWED = permissions.network ? '1' : '0'
    environment.AGENT_OFFICE_FILESYSTEM_ALLOWED = permissions.filesystem ? '1' : '0'
    environment.AGENT_OFFICE_GIT_ALLOWED = permissions.git ? '1' : '0'
    environment.AGENT_OFFICE_SECRETS_ALLOWED = permissions.secrets ? '1' : '0'
    const injectedSoul = permissions.secrets ? profile?.soul ?? '' : redactSecrets(profile?.soul ?? '')
    const injectedPrompt = permissions.secrets ? taskPrompt : redactSecrets(taskPrompt)
    const plan = executionPlan({
      platform: process.platform,
      permissions,
      cwd,
      userDataPath: app.getPath('userData'),
      shell,
      environment,
    })
    const term = pty.spawn(plan.file, plan.args, {
      name: 'xterm-256color',
      cols: 120,
      rows: 30,
      cwd,
      env: {
        ...environment,
        AGENT_OFFICE_PROFILE: profile?.name ?? '',
        AGENT_OFFICE_SOUL: injectedSoul,
        AGENT_OFFICE_TASK_ID: taskId ?? '',
        AGENT_OFFICE_TASK_PROMPT: injectedPrompt,
      } as Record<string, string>
    })
    sessions.set(storedAgent.id, term)
    circuitStates.set(storedAgent.id, { steerCount: 0, lastSteerAt: 0, constrained: false })
    if (taskId) taskOutputs.set(taskId, '')
    db.prepare("UPDATE agents SET status='working' WHERE id=?").run(storedAgent.id)
    term.onData(data => {
      if (taskId) taskOutputs.set(taskId, `${taskOutputs.get(taskId) ?? ''}${data}`.slice(-100_000))
      event.sender.send('terminal:data', { id: storedAgent.id, data })
    })
    term.onExit(({ exitCode }) => {
      sessions.delete(storedAgent.id)
      circuitStates.delete(storedAgent.id)
      if (quitting) return
      db.prepare("UPDATE agents SET status=? WHERE id=?").run(exitCode === 0 ? 'idle' : 'error', storedAgent.id)
      if (taskId) {
        const timeout = taskTimeouts.get(taskId)
        if (timeout) clearTimeout(timeout)
        taskTimeouts.delete(taskId)
        const taskStatus: TaskStatus = exitCode === 0 ? 'review' : 'failed'
        const output = redactSecrets(taskOutputs.get(taskId) ?? '')
        taskOutputs.delete(taskId)
        const run = taskRuns.get(taskId)
        taskRuns.delete(taskId)
        if (run) db.prepare('UPDATE execution_usage SET finished_at=?, duration_ms=?, output_bytes=?, exit_code=? WHERE id=?')
          .run(new Date().toISOString(), Date.now() - run.startedAt, Buffer.byteLength(output, 'utf8'), exitCode, run.id)
        db.prepare("UPDATE tasks SET status=?, blocked_reason=NULL, updated_at=CURRENT_TIMESTAMP, result=?, error=?, branch=COALESCE(branch, ?) WHERE id=?").run(taskStatus, exitCode === 0 ? output : null, exitCode === 0 ? null : `Process exited with code ${exitCode}`, storedAgent.branch ?? null, taskId)
        
      const mission = db.prepare('SELECT mission_id AS missionId FROM tasks WHERE id=?').get(taskId) as { missionId?: string | null } | undefined
      refreshMissionStatus(mission?.missionId)
        recordEvent(project, storedAgent.id, 'task.finished', { taskId, status: taskStatus, exitCode })
        if (taskStatus === 'review' && project) promoteDependentTasks(project.id)
      }
      event.sender.send('agent:exit', { id: storedAgent.id, exitCode })
    })
    if (taskId && taskPrompt) setTimeout(() => term.write(`${taskPrompt}\r`), 750)
    return true
  })

  ipcMain.on('terminal:write', (event, payload: unknown) => {
    assertTrustedRenderer(event)
    if (!payload || typeof payload !== 'object') return
    const { id, data } = payload as { id?: unknown; data?: unknown }
    if (typeof id !== 'string' || typeof data !== 'string' || data.length > 100_000) return
    sessions.get(id)?.write(data)
  })
  ipcMain.on('terminal:resize', (event, payload: unknown) => {
    assertTrustedRenderer(event)
    if (!payload || typeof payload !== 'object') return
    const { id, cols, rows } = payload as { id?: unknown; cols?: unknown; rows?: unknown }
    if (typeof id !== 'string' || !Number.isInteger(cols) || !Number.isInteger(rows) || Number(cols) < 1 || Number(cols) > 500 || Number(rows) < 1 || Number(rows) > 500) return
    sessions.get(id)?.resize(Number(cols), Number(rows))
  })
  ipcMain.handle('agent:stop', (_event, id: string) => {
    const session = sessions.get(id)
    if (!session) return false
    session.kill()
    circuitStates.delete(id)
    const agentProject = db.prepare('SELECT project_id AS projectId FROM agents WHERE id=?').get(id) as { projectId?: string } | undefined
    recordEvent(agentProject?.projectId ? getProject(agentProject.projectId) : undefined, id, 'agent.stopped')
    return true
  })
  ipcMain.handle('agent:control', (event, input: { id: string; action: 'pause' | 'resume' | 'interrupt' | 'steer' | 'constrain'; text?: string }) => {
    const session = sessions.get(input.id)
    if (!session) throw new Error('Agent has no active session')
    const agentProject = db.prepare('SELECT project_id AS projectId FROM agents WHERE id=?').get(input.id) as { projectId?: string } | undefined
    const project = agentProject?.projectId ? getProject(agentProject.projectId) : undefined
    if (input.action === 'steer') {
      const text = input.text?.trim()
      if (!text) throw new Error('Steer prompt cannot be empty')
      if (text.length > 2_000) throw new Error('Steer prompt cannot exceed 2,000 characters')
      const circuit = circuitStates.get(input.id) ?? { steerCount: 0, lastSteerAt: 0, constrained: false }
      if (circuit.constrained) throw new Error('Agent is constrained; start a new session after interrupting or stopping it')
      const now = Date.now()
      if (now - circuit.lastSteerAt < 1_000) throw new Error('Steer requests are rate limited to one per second')
      if (circuit.steerCount >= 10) {
        circuit.constrained = true
        circuitStates.set(input.id, circuit)
        recordEvent(project, input.id, 'agent.circuit-open', { reason: 'steer-budget-exhausted' })
        throw new Error('Steer budget exhausted; constrain, interrupt, or stop the agent')
      }
      circuit.steerCount += 1
      circuit.lastSteerAt = now
      circuitStates.set(input.id, circuit)
      session.write(`${text}\r`)
      recordEvent(project, input.id, 'agent.steered', { text })
    } else if (input.action === 'interrupt') {
      session.write('\u0003')
      recordEvent(project, input.id, 'agent.interrupted')
    } else if (input.action === 'constrain') {
      const circuit = circuitStates.get(input.id) ?? { steerCount: 0, lastSteerAt: 0, constrained: false }
      circuit.constrained = true
      circuitStates.set(input.id, circuit)
      const instruction = input.text?.trim() || 'Stop expanding scope. Work only on the current task, explain uncertainty, and wait for further direction.'
      session.write(`\r${instruction}\r`)
      recordEvent(project, input.id, 'agent.constrained', { instruction })
    } else if (process.platform === 'win32') {
      throw new Error('Pause/resume process control is not supported on Windows yet')
    } else {
      process.kill(session.pid, input.action === 'pause' ? 'SIGSTOP' : 'SIGCONT')
      db.prepare("UPDATE agents SET status=? WHERE id=?").run(input.action === 'pause' ? 'paused' : 'working', input.id)
      event.sender.send('agent:state', { id: input.id, status: input.action === 'pause' ? 'paused' : 'working' })
      recordEvent(project, input.id, `agent.${input.action}`)
    }
    return true
  })

  ipcMain.handle('git:acquire-commit-lock', (_event, input: { projectId: string; agentId: string }) => {
    const agent = db.prepare('SELECT project_id AS projectId, profile_id AS profileId, worktree_path AS worktreePath, branch FROM agents WHERE id=?').get(input.agentId) as { projectId: string; profileId?: string | null; worktreePath?: string | null; branch?: string | null } | undefined
    const project = getProject(input.projectId)
    if (!project || !agent || agent.projectId !== project.id || !agent.worktreePath || !agent.branch) throw new Error('Only an agent with an isolated Git worktree can acquire the commit lock')
    if (agent.profileId === 'michael') throw new Error('Supervisor cannot acquire a worker commit lock')
    const owner = db.prepare('SELECT agent_id AS agentId FROM commit_locks WHERE project_id=?').get(project.id) as { agentId: string } | undefined
    if (owner && owner.agentId !== input.agentId) throw new Error('Another agent currently owns the project commit lock')
    db.prepare(`INSERT INTO commit_locks (project_id, agent_id) VALUES (?, ?)
      ON CONFLICT(project_id) DO UPDATE SET agent_id=excluded.agent_id, acquired_at=CURRENT_TIMESTAMP`).run(project.id, input.agentId)
    recordEvent(project, input.agentId, 'git.commit-lock-acquired')
    return true
  })

  ipcMain.handle('git:release-commit-lock', (_event, input: { projectId: string; agentId: string }) => {
    const result = db.prepare('DELETE FROM commit_locks WHERE project_id=? AND agent_id=?').run(input.projectId, input.agentId)
    if (result.changes) recordEvent(getProject(input.projectId), input.agentId, 'git.commit-lock-released')
    return result.changes > 0
  })

  ipcMain.handle('git:commit', (_event, input: { agentId: string; message: string }) => {
    const agent = db.prepare('SELECT id, project_id AS projectId, profile_id AS profileId, worktree_path AS worktreePath, branch FROM agents WHERE id=?').get(input.agentId) as { id: string; projectId: string; profileId?: string | null; worktreePath?: string | null; branch?: string | null } | undefined
    if (!agent || !agent.worktreePath || !agent.branch) throw new Error('Agent has no isolated worktree/branch')
    if (agent.profileId === 'michael') throw new Error('Supervisor cannot commit worker changes')
    if (!profilePermissions(agent.profileId).git) throw new Error('Agent profile does not allow Git operations')
    const owner = db.prepare('SELECT agent_id AS agentId FROM commit_locks WHERE project_id=?').get(agent.projectId) as { agentId: string } | undefined
    if (!owner || owner.agentId !== agent.id) throw new Error('Acquire the single-committer lock before committing')
    const message = input.message.trim()
    if (!message || message.length > 200 || /[\r\n]/.test(message)) throw new Error('Commit message must be one non-empty line under 200 characters')
    const output = git(agent.worktreePath, ['commit', '-am', message])
    db.prepare('DELETE FROM commit_locks WHERE project_id=? AND agent_id=?').run(agent.projectId, agent.id)
    recordEvent(getProject(agent.projectId), agent.id, 'git.committed', { branch: agent.branch, message })
    recordEvent(getProject(agent.projectId), agent.id, 'git.commit-lock-released', { reason: 'commit-completed' })
    return { output: redactSecrets(output), branch: agent.branch }
  })

  ipcMain.handle('system:detectCli', () => {
    const candidates = ['codex', 'opencode', 'claude', 'gemini', 'qwen', 'copilot']
    const { execSync } = require('node:child_process')
    return candidates.map(command => {
      try {
        const bin = execSync(process.platform === 'win32' ? `where ${command}` : `command -v ${command}`, { encoding: 'utf8' }).trim()
        return { command, installed: Boolean(bin), path: bin }
      } catch {
        return { command, installed: false, path: null }
      }
    })
  })

  ipcMain.handle = nativeHandle
}

app.whenReady().then(() => {
  initDb()
  registerIpc()
  mailboxRouter = startMailboxRouter()
  scheduler = startScheduler()
  createWindow()
  app.on('activate', () => BrowserWindow.getAllWindows().length === 0 && createWindow())
})

app.on('will-quit', () => {
  quitting = true
  if (mailboxRouter) clearInterval(mailboxRouter)
  if (scheduler) clearInterval(scheduler)
  for (const session of sessions.values()) session.kill()
  if (db) db.close()
})

app.on('window-all-closed', () => {
  for (const session of sessions.values()) session.kill()
  if (process.platform !== 'darwin') app.quit()
})
