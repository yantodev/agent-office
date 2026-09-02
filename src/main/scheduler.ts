import fs from 'node:fs'
import { randomUUID } from 'node:crypto'
import Database from 'better-sqlite3'
import { resolveTaskReadiness } from './task-lifecycle'

type Project = { id: string; name: string; path: string; defaultBranch: string; useWorktrees: number }
type Schedule = { id: string; projectId: string; name: string; prompt: string; agentId?: string | null; intervalMinutes: number; timezone: string; nextRunAt: string; enabled: number }

export type SchedulerDependencies = {
  db: Database.Database
  getProject: (id: string) => Project | undefined
  getAllProjects: () => Project[]
  validateMemoryPath: (project: Project, value: string) => string
  requiresApproval: (text: string) => boolean
  recordEvent: (project: Project | undefined, agentId: string | null, type: string, payload?: Record<string, unknown>) => void
}

export function processSchedules(deps: SchedulerDependencies) {
  const now = new Date()
  const due = deps.db.prepare(`
    SELECT id, project_id AS projectId, name, prompt, agent_id AS agentId,
      interval_minutes AS intervalMinutes, timezone, next_run_at AS nextRunAt, enabled
    FROM schedules WHERE enabled=1 AND next_run_at<=? ORDER BY next_run_at
  `).all(now.toISOString()) as Schedule[]
  for (const schedule of due) {
    const project = deps.getProject(schedule.projectId)
    if (!project) continue
    const run = deps.db.transaction(() => {
      let next = new Date(schedule.nextRunAt)
      do next = new Date(next.getTime() + schedule.intervalMinutes * 60_000)
      while (next <= now)
      const taskId = randomUUID()
      const approvalStatus = deps.requiresApproval(schedule.prompt) ? 'pending' : 'not_required'
      const readiness = resolveTaskReadiness(schedule.agentId, true, approvalStatus === 'pending')
      deps.db.prepare('UPDATE schedules SET next_run_at=?, updated_at=CURRENT_TIMESTAMP WHERE id=?').run(next.toISOString(), schedule.id)
      deps.db.prepare(`INSERT INTO tasks (id, project_id, title, prompt, status, agent_id, approval_status, blocked_reason) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(taskId, project.id, `[Schedule] ${schedule.name}`, schedule.prompt, readiness.status, schedule.agentId ?? null, approvalStatus, readiness.blockedReason)
      if (approvalStatus === 'pending') {
        deps.db.prepare(`INSERT INTO approvals (id, project_id, task_id, type, title, reason, payload_json) VALUES (?, ?, ?, ?, ?, ?, ?)`).run(randomUUID(), project.id, taskId, 'safety', `Approve scheduled task: ${schedule.name}`, 'Scheduled prompt contains a potentially destructive, scope-changing, or costly operation.', JSON.stringify({ prompt: schedule.prompt }))
      }
      deps.recordEvent(project, schedule.agentId ?? null, 'schedule.triggered', { scheduleId: schedule.id, taskId })
    })
    try { run() } catch { /* percobaan berikutnya tetap memakai next_run_at yang durable */ }
  }
}

export function pruneExpiredMemories(deps: SchedulerDependencies, projectId?: string) {
  const projects = projectId ? [deps.getProject(projectId)].filter(Boolean) as Project[] : deps.getAllProjects()
  let removed = 0
  for (const project of projects) {
    const expired = deps.db.prepare(`SELECT id, file_path AS filePath FROM memories
      WHERE project_id=? AND pinned=0 AND retention_days IS NOT NULL
      AND datetime(updated_at, '+' || retention_days || ' days') < CURRENT_TIMESTAMP`).all(project.id) as Array<{ id: string; filePath: string }>
    for (const memory of expired) {
      try {
        deps.validateMemoryPath(project, memory.filePath)
        fs.rmSync(memory.filePath, { force: true })
        fs.rmSync(`${memory.filePath}.metadata`, { force: true })
      } catch (error) {
        deps.recordEvent(project, null, 'memory.expiry-blocked', { memoryId: memory.id, reason: error instanceof Error ? error.message : 'invalid memory path' })
        continue
      }
      deps.db.prepare('DELETE FROM memories WHERE id=?').run(memory.id)
      deps.recordEvent(project, null, 'memory.expired', { memoryId: memory.id })
      removed += 1
    }
  }
  return removed
}

export function startScheduler(deps: SchedulerDependencies) {
  processSchedules(deps)
  pruneExpiredMemories(deps)
  return setInterval(() => { processSchedules(deps); pruneExpiredMemories(deps) }, 30_000)
}
