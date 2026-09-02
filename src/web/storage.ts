import Database from 'better-sqlite3'
import { redactSecrets } from '../main/security'

export type WebStorage = {
  listProjects: () => unknown[]
  listTasks: (projectId: string) => unknown[]
  listEvents: (projectId: string) => unknown[]
  listMessages: (projectId: string) => unknown[]
  listApprovals: (projectId: string) => unknown[]
  listMemories: (projectId: string) => unknown[]
  resolveApproval: (id: string, status: 'approved' | 'rejected') => boolean
}

export function createSqliteStorage(db: Database.Database): WebStorage {
  return {
    listProjects: () => db.prepare('SELECT id, name, path, default_branch AS defaultBranch, use_worktrees AS useWorktrees FROM projects ORDER BY name').all(),
    listTasks: projectId => (db.prepare(`SELECT id, project_id AS projectId, title, prompt, status, agent_id AS agentId,
      result, error, mission_id AS missionId, approval_status AS approvalStatus, review_status AS reviewStatus,
      review_notes AS reviewNotes, blocked_reason AS blockedReason, branch, budget_minutes AS budgetMinutes,
      created_at AS createdAt, updated_at AS updatedAt FROM tasks WHERE project_id=? ORDER BY created_at DESC`).all(projectId) as Array<Record<string, unknown>>).map(row => redactRow(row)),
    listEvents: projectId => (db.prepare(`SELECT id, project_id AS projectId, agent_id AS agentId, type,
      payload_json AS payloadJson, created_at AS createdAt FROM events WHERE project_id=? ORDER BY created_at DESC LIMIT 200`).all(projectId) as Array<Record<string, unknown>>).map(row => ({ ...redactRow(row), payload: parseJson(row.payloadJson), payloadJson: undefined })),
    listMessages: projectId => (db.prepare(`SELECT message_id AS id, project_id AS projectId, from_agent AS fromAgent,
      to_agent AS toAgent, body, status, attempts, last_error AS lastError, created_at AS createdAt
      FROM messages WHERE project_id=? ORDER BY created_at DESC LIMIT 100`).all(projectId) as Array<Record<string, unknown>>).map(row => redactRow(row)),
    listApprovals: projectId => (db.prepare(`SELECT id, project_id AS projectId, task_id AS taskId, type, title,
      reason, status, created_at AS createdAt, resolved_at AS resolvedAt FROM approvals WHERE project_id=? ORDER BY created_at DESC`).all(projectId) as Array<Record<string, unknown>>).map(row => redactRow(row)),
    listMemories: projectId => (db.prepare(`SELECT id, project_id AS projectId, agent_id AS agentId, title,
      category, body, pinned, retention_days AS retentionDays, created_at AS createdAt, updated_at AS updatedAt
      FROM memories WHERE project_id=? ORDER BY updated_at DESC`).all(projectId) as Array<Record<string, unknown>>).map(row => redactRow(row)),
    resolveApproval: (id, status) => db.prepare("UPDATE approvals SET status=?, resolved_at=CURRENT_TIMESTAMP WHERE id=? AND status='pending'").run(status, id).changes > 0,
  }
}

function parseJson(value: unknown) {
  try { return JSON.parse(String(value)) } catch { return {} }
}

function redactRow<T extends Record<string, unknown>>(row: T) {
  return Object.fromEntries(Object.entries(row).map(([key, value]) => [key, typeof value === 'string' ? redactSecrets(value) : value]))
}
