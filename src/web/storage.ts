import Database from 'better-sqlite3'
import { basename, isAbsolute, join } from 'node:path'
import { redactSecrets } from '../main/security.ts'

export type WebStorage = {
  listProjects: () => unknown[]
  activeProject: () => unknown | null
  createProject: (input: { id: string; name?: string; path: string; useWorktrees?: boolean }) => unknown
  setActiveProject: (id: string) => unknown | null
  removeProject: (id: string) => boolean
  listTasks: (projectId: string) => unknown[]
  createTask: (input: { id: string; projectId: string; title: string; prompt: string; agentId?: string | null; dependsOnTaskIds?: string[] }) => unknown
  updateTask: (input: { id: string; status?: string; agentId?: string | null }) => unknown | null
  addTaskArtifact: (input: { taskId: string; label: string; kind?: string; location: string; metadata?: Record<string, unknown> }) => unknown
  setTaskReview: (input: { taskId: string; status: string; notes?: string }) => unknown | null
  listMissions: (projectId: string) => unknown[]
  createMission: (input: { id: string; projectId: string; title?: string; request: string }) => unknown
  listSchedules: (projectId: string) => unknown[]
  createSchedule: (input: { id: string; projectId: string; name: string; prompt: string; agentId?: string | null; intervalMinutes: number; timezone?: string }) => unknown
  updateSchedule: (input: { id: string; enabled?: boolean; intervalMinutes?: number; nextRunAt?: string }) => unknown | null
  removeSchedule: (id: string) => boolean
  listApprovals: (projectId: string) => unknown[]
  resolveApproval: (id: string, status: 'approved' | 'rejected') => boolean
  listMessages: (projectId: string) => unknown[]
  sendMessage: (input: { projectId: string; fromAgent: string; toAgent: string; body: string }) => unknown
  acknowledgeMessage: (input: { messageId: string; projectId: string; agentId: string }) => boolean
  listEvents: (projectId: string) => unknown[]
  recordEvent: (input: { projectId: string; agentId?: string | null; type: string; payload?: Record<string, unknown> }) => void
  listMemories: (input: { projectId: string; query?: string }) => unknown[]
  saveMemory: (input: { id?: string; projectId: string; agentId?: string | null; title: string; category: string; body: string }) => unknown
  removeMemory: (id: string) => boolean
  pinMemory: (input: { id: string; pinned: boolean }) => boolean
  pruneMemories: (projectId: string) => number
  listProfiles: () => unknown[]
  createProfile: (input: { id: string; name: string; role: string; command: string; soul: string; permissions?: Record<string, boolean> }) => unknown
  updateProfile: (input: { id: string; name: string; role: string; command: string; soul: string; permissions?: Record<string, boolean> }) => unknown | null
  removeProfile: (id: string) => boolean
  listAgents: () => unknown[]
  getAgent: (id: string) => { id: string; name: string; command: string; cwd: string; role: string; projectId?: string | null; profileId?: string | null } | null
  createAgent: (input: { id: string; name: string; role: string; command: string; cwd?: string; projectId?: string | null; profileId?: string | null }) => unknown
  removeAgent: (id: string) => boolean
  setAgentStatus: (id: string, status: string) => void
  fleetSummary: (projectId?: string) => unknown | null
}

const defaultPermissions = { filesystem: true, network: true, shell: true, git: true, secrets: false }

export function createSqliteStorage(db: Database.Database): WebStorage {
  const parse = (value: unknown) => {
    try { return JSON.parse(String(value)) } catch { return {} }
  }
  const redactRow = <T extends Record<string, unknown>>(row: T) => Object.fromEntries(Object.entries(row).map(([key, value]) => [key, typeof value === 'string' ? redactSecrets(value) : value]))
  const project = (id: string) => db.prepare('SELECT id, name, path, default_branch AS defaultBranch, use_worktrees AS useWorktrees FROM projects WHERE id=?').get(id) as Record<string, unknown> | undefined
  const recordEvent = (input: { projectId: string; agentId?: string | null; type: string; payload?: Record<string, unknown> }) => {
    db.prepare('INSERT INTO events (id, project_id, agent_id, type, payload_json) VALUES (?, ?, ?, ?, ?)')
      .run(crypto.randomUUID(), input.projectId, input.agentId ?? null, input.type, JSON.stringify(input.payload ?? {}))
  }

  return {
    listProjects: () => db.prepare('SELECT id, name, path, default_branch AS defaultBranch, use_worktrees AS useWorktrees FROM projects ORDER BY name').all(),
    activeProject: () => {
      const value = db.prepare("SELECT value FROM settings WHERE key='active_project'").get() as { value: string } | undefined
      return value ? project(value.value) ?? null : null
    },
    createProject: input => {
      if (!input.id || !input.path || !isAbsolute(input.path)) throw new Error('Project path must be absolute')
      const name = input.name?.trim() || basename(input.path)
      db.prepare('INSERT INTO projects (id, name, path, use_worktrees) VALUES (?, ?, ?, ?)').run(input.id, name, input.path, input.useWorktrees ? 1 : 0)
      return project(input.id)
    },
    setActiveProject: id => {
      if (!project(id)) return null
      db.prepare("INSERT INTO settings (key, value) VALUES ('active_project', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(id)
      return project(id)
    },
    removeProject: id => db.prepare('DELETE FROM projects WHERE id=?').run(id).changes > 0,
    listTasks: projectId => {
      const tasks = db.prepare(`SELECT id, project_id AS projectId, title, prompt, status, agent_id AS agentId,
        result, error, mission_id AS missionId, approval_status AS approvalStatus, review_status AS reviewStatus,
        review_notes AS reviewNotes, blocked_reason AS blockedReason, branch, budget_minutes AS budgetMinutes,
        created_at AS createdAt, updated_at AS updatedAt FROM tasks WHERE project_id=? ORDER BY created_at DESC`).all(projectId) as Array<Record<string, unknown>>
      return tasks.map(task => ({
        ...redactRow(task),
        dependencies: db.prepare(`SELECT t.id, t.title, t.status FROM task_dependencies d JOIN tasks t ON t.id=d.depends_on_task_id WHERE d.task_id=?`).all(task.id),
        artifacts: (db.prepare(`SELECT id, label, kind, location, metadata_json AS metadataJson, created_at AS createdAt FROM task_artifacts WHERE task_id=? ORDER BY created_at`).all(task.id) as Array<Record<string, unknown>>).map(artifact => ({ ...artifact, metadata: parse(artifact.metadataJson), metadataJson: undefined })),
      }))
    },
    createTask: input => {
      if (!project(input.projectId)) throw new Error('Project not found')
      const agentId = input.agentId || null
      const status = agentId ? 'assigned' : 'backlog'
      db.prepare('INSERT INTO tasks (id, project_id, title, prompt, agent_id, status) VALUES (?, ?, ?, ?, ?, ?)').run(input.id, input.projectId, input.title.trim(), input.prompt.trim(), agentId, status)
      for (const dependency of input.dependsOnTaskIds ?? []) db.prepare('INSERT INTO task_dependencies (task_id, depends_on_task_id) VALUES (?, ?)').run(input.id, dependency)
      recordEvent({ projectId: input.projectId, type: 'task.created', payload: { taskId: input.id } })
      return thisListTask(db, input.id, redactRow, parse)
    },
    updateTask: input => {
      const current = db.prepare('SELECT id, project_id AS projectId FROM tasks WHERE id=?').get(input.id) as { id: string; projectId: string } | undefined
      if (!current) return null
      if (input.status !== undefined) db.prepare('UPDATE tasks SET status=?, updated_at=CURRENT_TIMESTAMP WHERE id=?').run(input.status, input.id)
      if (input.agentId !== undefined) db.prepare('UPDATE tasks SET agent_id=?, updated_at=CURRENT_TIMESTAMP WHERE id=?').run(input.agentId || null, input.id)
      recordEvent({ projectId: current.projectId, type: 'task.updated', payload: { taskId: input.id, status: input.status, agentId: input.agentId } })
      return thisListTask(db, input.id, redactRow, parse)
    },
    addTaskArtifact: input => {
      const id = crypto.randomUUID()
      db.prepare('INSERT INTO task_artifacts (id, task_id, label, kind, location, metadata_json) VALUES (?, ?, ?, ?, ?, ?)').run(id, input.taskId, input.label, input.kind ?? 'file', input.location, JSON.stringify(input.metadata ?? {}))
      return db.prepare('SELECT id, task_id AS taskId, label, kind, location, metadata_json AS metadataJson, created_at AS createdAt FROM task_artifacts WHERE id=?').get(id)
    },
    setTaskReview: input => {
      const current = db.prepare('SELECT project_id AS projectId FROM tasks WHERE id=?').get(input.taskId) as { projectId: string } | undefined
      if (!current) return null
      db.prepare('UPDATE tasks SET review_status=?, review_notes=?, updated_at=CURRENT_TIMESTAMP WHERE id=?').run(input.status, input.notes ?? null, input.taskId)
      recordEvent({ projectId: current.projectId, type: 'task.review-updated', payload: { taskId: input.taskId, status: input.status } })
      return thisListTask(db, input.taskId, redactRow, parse)
    },
    listMissions: projectId => db.prepare('SELECT id, project_id AS projectId, title, request, status, summary, created_at AS createdAt, updated_at AS updatedAt FROM missions WHERE project_id=? ORDER BY created_at DESC').all(projectId),
    createMission: input => {
      db.prepare('INSERT INTO missions (id, project_id, title, request) VALUES (?, ?, ?, ?)').run(input.id, input.projectId, input.title?.trim() || 'Untitled mission', input.request.trim())
      recordEvent({ projectId: input.projectId, type: 'mission.created', payload: { missionId: input.id } })
      return db.prepare('SELECT id, project_id AS projectId, title, request, status, created_at AS createdAt, updated_at AS updatedAt FROM missions WHERE id=?').get(input.id)
    },
    listSchedules: projectId => db.prepare(`SELECT s.id, s.project_id AS projectId, s.name, s.prompt, s.agent_id AS agentId,
      a.name AS agentName, s.interval_minutes AS intervalMinutes, s.timezone, s.next_run_at AS nextRunAt, s.enabled
      FROM schedules s LEFT JOIN agents a ON a.id=s.agent_id WHERE s.project_id=? ORDER BY s.next_run_at`).all(projectId),
    createSchedule: input => {
      if (!Number.isInteger(input.intervalMinutes) || input.intervalMinutes < 1) throw new Error('Schedule interval must be at least one minute')
      const next = new Date(Date.now() + input.intervalMinutes * 60_000).toISOString()
      db.prepare('INSERT INTO schedules (id, project_id, name, prompt, agent_id, interval_minutes, timezone, next_run_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(input.id, input.projectId, input.name.trim(), input.prompt.trim(), input.agentId || null, input.intervalMinutes, input.timezone || 'UTC', next)
      return db.prepare('SELECT id, project_id AS projectId, name, prompt, agent_id AS agentId, interval_minutes AS intervalMinutes, timezone, next_run_at AS nextRunAt, enabled FROM schedules WHERE id=?').get(input.id)
    },
    updateSchedule: input => {
      const current = db.prepare('SELECT id FROM schedules WHERE id=?').get(input.id)
      if (!current) return null
      if (input.enabled !== undefined) db.prepare('UPDATE schedules SET enabled=?, updated_at=CURRENT_TIMESTAMP WHERE id=?').run(input.enabled ? 1 : 0, input.id)
      if (input.intervalMinutes !== undefined) db.prepare('UPDATE schedules SET interval_minutes=?, updated_at=CURRENT_TIMESTAMP WHERE id=?').run(input.intervalMinutes, input.id)
      if (input.nextRunAt !== undefined) db.prepare('UPDATE schedules SET next_run_at=?, updated_at=CURRENT_TIMESTAMP WHERE id=?').run(input.nextRunAt, input.id)
      return db.prepare('SELECT id, project_id AS projectId, name, prompt, agent_id AS agentId, interval_minutes AS intervalMinutes, timezone, next_run_at AS nextRunAt, enabled FROM schedules WHERE id=?').get(input.id)
    },
    removeSchedule: id => db.prepare('DELETE FROM schedules WHERE id=?').run(id).changes > 0,
    listApprovals: projectId => db.prepare(`SELECT a.id, a.project_id AS projectId, a.task_id AS taskId, t.title AS taskTitle,
      a.type, a.title, a.reason, a.status, a.created_at AS createdAt, a.resolved_at AS resolvedAt
      FROM approvals a LEFT JOIN tasks t ON t.id=a.task_id WHERE a.project_id=? ORDER BY a.created_at DESC`).all(projectId),
    resolveApproval: (id, status) => db.prepare("UPDATE approvals SET status=?, resolved_at=CURRENT_TIMESTAMP WHERE id=? AND status='pending'").run(status, id).changes > 0,
    listMessages: projectId => (db.prepare(`SELECT message_id AS id, project_id AS projectId, from_agent AS fromAgent,
      to_agent AS toAgent, from_agent AS fromName, to_agent AS toName, body, status, attempts, last_error AS lastError, created_at AS createdAt
      FROM messages WHERE project_id=? ORDER BY created_at DESC LIMIT 100`).all(projectId) as Array<Record<string, unknown>>).map(redactRow),
    sendMessage: input => {
      const id = crypto.randomUUID()
      db.prepare('INSERT INTO messages (message_id, project_id, from_agent, to_agent, body) VALUES (?, ?, ?, ?, ?)').run(id, input.projectId, input.fromAgent, input.toAgent, input.body.trim())
      recordEvent({ projectId: input.projectId, type: 'message.created', payload: { messageId: id, fromAgent: input.fromAgent, toAgent: input.toAgent } })
      return db.prepare('SELECT message_id AS id, project_id AS projectId, from_agent AS fromAgent, to_agent AS toAgent, body, status, attempts, last_error AS lastError, created_at AS createdAt FROM messages WHERE message_id=?').get(id)
    },
    acknowledgeMessage: input => db.prepare("UPDATE messages SET status='read' WHERE message_id=? AND project_id=? AND to_agent=?").run(input.messageId, input.projectId, input.agentId).changes > 0,
    listEvents: projectId => (db.prepare(`SELECT id, project_id AS projectId, agent_id AS agentId, type, payload_json AS payloadJson, created_at AS createdAt FROM events WHERE project_id=? ORDER BY created_at DESC LIMIT 200`).all(projectId) as Array<Record<string, unknown>>).map(row => ({ ...redactRow(row), payload: parse(row.payloadJson), payloadJson: undefined })),
    recordEvent,
    listMemories: input => {
      const query = input.query?.trim()
      const rows = (query
        ? db.prepare(`SELECT m.id, m.project_id AS projectId, m.agent_id AS agentId, a.name AS agentName, m.title, m.category, m.body,
          m.file_path AS filePath, m.pinned, m.retention_days AS retentionDays, m.created_at AS createdAt, m.updated_at AS updatedAt
          FROM memories m LEFT JOIN agents a ON a.id=m.agent_id WHERE m.project_id=? AND (m.title LIKE ? OR m.body LIKE ?) ORDER BY m.pinned DESC, m.updated_at DESC`).all(input.projectId, `%${query}%`, `%${query}%`)
        : db.prepare(`SELECT m.id, m.project_id AS projectId, m.agent_id AS agentId, a.name AS agentName, m.title, m.category, m.body,
          m.file_path AS filePath, m.pinned, m.retention_days AS retentionDays, m.created_at AS createdAt, m.updated_at AS updatedAt
          FROM memories m LEFT JOIN agents a ON a.id=m.agent_id WHERE m.project_id=? ORDER BY m.pinned DESC, m.updated_at DESC`).all(input.projectId)) as Array<Record<string, unknown>>
      return rows.map(redactRow)
    },
    saveMemory: input => {
      const id = input.id || crypto.randomUUID()
      const filePath = join('.agent-office', 'memory', `${id}.md`)
      db.prepare(`INSERT INTO memories (id, project_id, agent_id, title, category, body, file_path)
        VALUES (@id, @projectId, @agentId, @title, @category, @body, @filePath)
        ON CONFLICT(id) DO UPDATE SET agent_id=@agentId, title=@title, category=@category, body=@body, updated_at=CURRENT_TIMESTAMP`).run({ id, projectId: input.projectId, agentId: input.agentId || null, title: input.title.trim(), category: input.category.trim() || 'general', body: input.body.trim(), filePath })
      recordEvent({ projectId: input.projectId, agentId: input.agentId, type: 'memory.updated', payload: { memoryId: id } })
      return db.prepare('SELECT id, project_id AS projectId, agent_id AS agentId, title, category, body, file_path AS filePath, pinned, retention_days AS retentionDays, created_at AS createdAt, updated_at AS updatedAt FROM memories WHERE id=?').get(id)
    },
    removeMemory: id => db.prepare('DELETE FROM memories WHERE id=?').run(id).changes > 0,
    pinMemory: input => db.prepare('UPDATE memories SET pinned=?, updated_at=CURRENT_TIMESTAMP WHERE id=?').run(input.pinned ? 1 : 0, input.id).changes > 0,
    pruneMemories: projectId => db.prepare('DELETE FROM memories WHERE project_id=? AND pinned=0 AND retention_days IS NOT NULL AND datetime(updated_at, "+" || retention_days || " days") < CURRENT_TIMESTAMP').run(projectId).changes,
    listProfiles: () => (db.prepare('SELECT id, name, role, command, soul, permissions_json AS permissionsJson, built_in AS builtIn FROM profiles ORDER BY built_in DESC, name').all() as Array<Record<string, unknown>>).map(row => ({ ...row, permissions: { ...defaultPermissions, ...parse(row.permissionsJson) }, permissionsJson: undefined })),
    createProfile: input => {
      db.prepare('INSERT INTO profiles (id, name, role, command, soul, permissions_json) VALUES (?, ?, ?, ?, ?, ?)').run(input.id, input.name.trim(), input.role.trim(), input.command.trim(), input.soul ?? '', JSON.stringify(input.permissions ?? defaultPermissions))
      return db.prepare('SELECT id, name, role, command, soul, built_in AS builtIn FROM profiles WHERE id=?').get(input.id)
    },
    updateProfile: input => {
      const result = db.prepare("UPDATE profiles SET name=?, role=?, command=?, soul=?, permissions_json=? WHERE id=? AND built_in=0").run(input.name.trim(), input.role.trim(), input.command.trim(), input.soul ?? '', JSON.stringify(input.permissions ?? defaultPermissions), input.id)
      return result.changes ? db.prepare('SELECT id, name, role, command, soul, built_in AS builtIn FROM profiles WHERE id=?').get(input.id) : null
    },
    removeProfile: id => db.prepare('DELETE FROM profiles WHERE id=? AND built_in=0').run(id).changes > 0,
    listAgents: () => (db.prepare(`SELECT a.id, a.name, a.command, a.cwd, a.role, a.project_id AS projectId,
      p.name AS profileName, a.profile_id AS profileId, p.soul, project.name AS projectName, a.worktree_path AS worktreePath,
      a.branch, a.status FROM agents a LEFT JOIN profiles p ON p.id=a.profile_id LEFT JOIN projects project ON project.id=a.project_id ORDER BY a.name`).all() as Array<Record<string, unknown>>).map(row => ({ ...row, dirty: false })),
    getAgent: id => db.prepare('SELECT id, name, command, cwd, role, project_id AS projectId, profile_id AS profileId FROM agents WHERE id=?').get(id) as { id: string; name: string; command: string; cwd: string; role: string; projectId?: string | null; profileId?: string | null } | null,
    createAgent: input => {
      const currentProject = input.projectId ? project(input.projectId) : null
      const cwd = input.cwd && input.cwd !== '.' ? input.cwd : String(currentProject?.path ?? process.cwd())
      db.prepare('INSERT INTO agents (id, name, command, cwd, role, project_id, profile_id, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(input.id, input.name.trim(), input.command.trim(), cwd, input.role.trim(), input.projectId || null, input.profileId || null, 'idle')
      return db.prepare('SELECT id, name, command, cwd, role, project_id AS projectId, profile_id AS profileId, status FROM agents WHERE id=?').get(input.id)
    },
    removeAgent: id => db.prepare('DELETE FROM agents WHERE id=?').run(id).changes > 0,
    setAgentStatus: (id, status) => { db.prepare('UPDATE agents SET status=? WHERE id=?').run(status, id) },
    fleetSummary: projectId => {
      const scope = projectId ? ' WHERE project_id=?' : ''
      const args = projectId ? [projectId] : []
      const agents = db.prepare(`SELECT COUNT(*) AS total, SUM(status='working') AS working, SUM(status='paused') AS paused, SUM(status='error') AS errors FROM agents${scope}`).get(...args) as Record<string, number>
      const tasks = db.prepare(`SELECT COUNT(*) AS total, SUM(status IN ('backlog','assigned')) AS queued, SUM(status='running') AS running, SUM(status='failed') AS errors FROM tasks${scope}`).get(...args) as Record<string, number>
      const approvals = db.prepare(`SELECT COUNT(*) AS pending FROM approvals${projectId ? ' WHERE project_id=? AND status=\'pending\'' : " WHERE status='pending'"}`).get(...args) as Record<string, number>
      const usage = db.prepare(`SELECT COALESCE(SUM(COALESCE(duration_ms, 0)), 0) AS durationMs, COALESCE(SUM(output_bytes), 0) AS outputBytes FROM execution_usage u${projectId ? ' JOIN tasks t ON t.id=u.task_id WHERE t.project_id=?' : ''}`).get(...args) as Record<string, number>
      return { agents: { total: agents.total ?? 0, working: agents.working ?? 0, paused: agents.paused ?? 0, errors: agents.errors ?? 0 }, tasks: { total: tasks.total ?? 0, queued: tasks.queued ?? 0, running: tasks.running ?? 0, errors: tasks.errors ?? 0 }, approvals: { pending: approvals.pending ?? 0 }, usage: { durationMs: usage.durationMs ?? 0, outputBytes: usage.outputBytes ?? 0 } }
    },
  }
}

function thisListTask(db: Database.Database, id: string, redactRow: (row: Record<string, unknown>) => Record<string, unknown>, parse: (value: unknown) => unknown) {
  const task = db.prepare(`SELECT id, project_id AS projectId, title, prompt, status, agent_id AS agentId, result, error,
    mission_id AS missionId, approval_status AS approvalStatus, review_status AS reviewStatus, review_notes AS reviewNotes,
    blocked_reason AS blockedReason, branch, budget_minutes AS budgetMinutes, created_at AS createdAt, updated_at AS updatedAt
    FROM tasks WHERE id=?`).get(id) as Record<string, unknown> | undefined
  if (!task) return null
  return {
    ...redactRow(task),
    dependencies: db.prepare(`SELECT t.id, t.title, t.status FROM task_dependencies d JOIN tasks t ON t.id=d.depends_on_task_id WHERE d.task_id=?`).all(id),
    artifacts: (db.prepare(`SELECT id, label, kind, location, metadata_json AS metadataJson, created_at AS createdAt FROM task_artifacts WHERE task_id=?`).all(id) as Array<Record<string, unknown>>).map(artifact => ({ ...artifact, metadata: parse(artifact.metadataJson), metadataJson: undefined })),
  }
}
