import fs from 'node:fs'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { writeJsonAtomic } from './persistence'

type Project = { id: string; name: string; path: string; defaultBranch: string; useWorktrees: number }

export type MailboxDependencies = {
  db: Database.Database
  getProjects: () => Project[]
  ensureProjectWorkspace: (project: Project) => string
  recordEvent: (project: Project | undefined, agentId: string | null, type: string, payload?: Record<string, unknown>) => void
}

const watchdogNotices = new Map<string, number>()

function routePendingMessages(deps: MailboxDependencies, project: Project) {
  const root = deps.ensureProjectWorkspace(project)
  const outbox = join(root, 'outbox')
  for (const filename of fs.readdirSync(outbox)) {
    if (!filename.endsWith('.json')) continue
    const sourcePath = join(outbox, filename)
    let messageId: string | undefined
    try {
      const message = JSON.parse(fs.readFileSync(sourcePath, 'utf8')) as { id: string; toAgent: string }
      messageId = message.id
      if (!message.id || !message.toAgent) throw new Error('message requires id and toAgent')
      if (!/^[A-Za-z0-9_-]+$/.test(message.toAgent) || !deps.db.prepare('SELECT 1 FROM agents WHERE id=? AND project_id=?').get(message.toAgent, project.id)) throw new Error('message recipient is not a valid project agent')
      const targetPath = join(root, 'inbox', `${message.toAgent}-${message.id}.json`)
      if (!fs.existsSync(targetPath)) writeJsonAtomic(targetPath, message)
      deps.db.prepare("UPDATE messages SET status='delivered' WHERE message_id=? AND status!='dead-letter'").run(message.id)
      fs.rmSync(sourcePath, { force: true })
    } catch (error) {
      const reason = error instanceof Error ? error.message : 'invalid message'
      const attempts = messageId
        ? Number((deps.db.prepare('SELECT attempts FROM messages WHERE message_id=?').get(messageId) as { attempts?: number } | undefined)?.attempts ?? 0) + 1
        : 3
      if (messageId) deps.db.prepare('UPDATE messages SET attempts=?, last_error=?, status=? WHERE message_id=?').run(attempts, reason, attempts >= 3 ? 'dead-letter' : 'pending', messageId)
      if (attempts >= 3) {
        const deadLetterPath = join(root, 'logs', 'dead-letter')
        fs.mkdirSync(deadLetterPath, { recursive: true })
        try { fs.renameSync(sourcePath, join(deadLetterPath, filename)) } catch { /* file may be in-flight */ }
        deps.recordEvent(project, null, 'message.dead-letter', { filename, reason, attempts })
      } else {
        deps.recordEvent(project, null, 'message.retry', { filename, reason, attempts })
      }
    }
  }
}

function runMailboxWatchdog(deps: MailboxDependencies, project: Project) {
  const root = deps.ensureProjectWorkspace(project)
  const now = Date.now()
  const staleAfterMs = 10 * 60_000
  for (const folder of ['inbox', 'outbox']) {
    for (const filename of fs.readdirSync(join(root, folder))) {
      if (!filename.endsWith('.json')) continue
      const filePath = join(root, folder, filename)
      let stat: fs.Stats
      try { stat = fs.statSync(filePath) } catch { continue }
      if (now - stat.mtimeMs < staleAfterMs) continue
      const key = `${project.id}/${folder}/${filename}`
      if (watchdogNotices.get(key) === stat.mtimeMs) continue
      watchdogNotices.set(key, stat.mtimeMs)
      deps.recordEvent(project, null, 'mailbox.stalled', { folder, filename, ageMs: Math.round(now - stat.mtimeMs) })
    }
  }
}

export function startMailboxRouter(deps: MailboxDependencies) {
  const route = () => {
    for (const project of deps.getProjects()) {
      try {
        routePendingMessages(deps, project)
        runMailboxWatchdog(deps, project)
      } catch { /* router akan mencoba lagi pada interval berikutnya */ }
    }
  }
  route()
  return setInterval(route, 2000)
}
