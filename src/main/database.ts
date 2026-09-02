import fs from 'node:fs'
import { join } from 'node:path'
import Database from 'better-sqlite3'

const schema = `
  CREATE TABLE IF NOT EXISTS projects (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, path TEXT NOT NULL UNIQUE,
    default_branch TEXT NOT NULL DEFAULT 'HEAD', use_worktrees INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS profiles (
    id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, role TEXT NOT NULL,
    command TEXT NOT NULL DEFAULT 'codex', soul TEXT NOT NULL DEFAULT '',
    permissions_json TEXT NOT NULL DEFAULT '{}', built_in INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS missions (
    id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    title TEXT NOT NULL, request TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'planned',
    summary TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS agents (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, command TEXT NOT NULL, cwd TEXT NOT NULL,
    role TEXT NOT NULL, project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
    worktree_path TEXT, branch TEXT, profile_id TEXT REFERENCES profiles(id) ON DELETE SET NULL,
    status TEXT NOT NULL DEFAULT 'idle'
  );
  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT, message_id TEXT UNIQUE,
    project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
    from_agent TEXT NOT NULL, to_agent TEXT NOT NULL, body TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'delivered', attempts INTEGER NOT NULL DEFAULT 0,
    last_error TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS tasks (
    id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    title TEXT NOT NULL, prompt TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'backlog',
    agent_id TEXT REFERENCES agents(id) ON DELETE SET NULL, result TEXT, error TEXT,
    mission_id TEXT REFERENCES missions(id) ON DELETE SET NULL,
    approval_status TEXT NOT NULL DEFAULT 'not_required', review_status TEXT NOT NULL DEFAULT 'pending',
    review_notes TEXT, blocked_reason TEXT, branch TEXT, budget_minutes INTEGER,
    source_type TEXT, source_ref TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS task_dependencies (
    task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    depends_on_task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    PRIMARY KEY (task_id, depends_on_task_id), CHECK (task_id != depends_on_task_id)
  );
  CREATE TABLE IF NOT EXISTS task_artifacts (
    id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    label TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'file', location TEXT NOT NULL,
    metadata_json TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS approvals (
    id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    task_id TEXT REFERENCES tasks(id) ON DELETE CASCADE, type TEXT NOT NULL,
    title TEXT NOT NULL, reason TEXT NOT NULL, payload_json TEXT NOT NULL DEFAULT '{}',
    status TEXT NOT NULL DEFAULT 'pending', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    resolved_at TEXT
  );
  CREATE TABLE IF NOT EXISTS schedules (
    id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    name TEXT NOT NULL, prompt TEXT NOT NULL, agent_id TEXT REFERENCES agents(id) ON DELETE SET NULL,
    interval_minutes INTEGER NOT NULL CHECK (interval_minutes > 0), timezone TEXT NOT NULL DEFAULT 'UTC',
    next_run_at TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS execution_usage (
    id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    agent_id TEXT REFERENCES agents(id) ON DELETE SET NULL, started_at TEXT NOT NULL,
    finished_at TEXT, duration_ms INTEGER, output_bytes INTEGER NOT NULL DEFAULT 0, exit_code INTEGER
  );
  CREATE TABLE IF NOT EXISTS commit_locks (
    project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
    agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    acquired_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS github_issues (
    id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    issue_number INTEGER NOT NULL, title TEXT NOT NULL, body TEXT NOT NULL DEFAULT '', url TEXT,
    state TEXT NOT NULL, labels_json TEXT NOT NULL DEFAULT '[]', task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
    synced_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, UNIQUE(project_id, issue_number)
  );
  CREATE TABLE IF NOT EXISTS events (
    id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    agent_id TEXT, type TEXT NOT NULL, payload_json TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS memories (
    id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    agent_id TEXT REFERENCES agents(id) ON DELETE SET NULL, title TEXT NOT NULL,
    category TEXT NOT NULL DEFAULT 'general', body TEXT NOT NULL, file_path TEXT NOT NULL,
    pinned INTEGER NOT NULL DEFAULT 0, retention_days INTEGER,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS memory_vectors (
    memory_id TEXT PRIMARY KEY REFERENCES memories(id) ON DELETE CASCADE,
    vector_json TEXT NOT NULL, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
`

function ensureColumn(db: Database.Database, table: string, column: string, definition: string) {
  const columns = db.prepare(`PRAGMA table_info("${table}")`).all() as Array<{ name: string }>
  if (!columns.some(current => current.name === column)) db.exec(`ALTER TABLE "${table}" ADD COLUMN "${column}" ${definition}`)
}

export function openDatabase(userDataPath: string) {
  const dir = join(userDataPath, 'data')
  fs.mkdirSync(dir, { recursive: true })
  const db = new Database(join(dir, 'agent-office.db'))
  db.pragma('foreign_keys = ON')
  db.exec(schema)
  return db
}

export function migrateDatabase(db: Database.Database) {
  ensureColumn(db, 'projects', 'default_branch', "TEXT NOT NULL DEFAULT 'HEAD'")
  ensureColumn(db, 'projects', 'use_worktrees', 'INTEGER NOT NULL DEFAULT 0')
  ensureColumn(db, 'projects', 'created_at', 'TEXT')
  db.prepare("UPDATE projects SET created_at=CURRENT_TIMESTAMP WHERE created_at IS NULL").run()
  ensureColumn(db, 'agents', 'project_id', 'TEXT REFERENCES projects(id) ON DELETE SET NULL')
  ensureColumn(db, 'agents', 'worktree_path', 'TEXT')
  ensureColumn(db, 'agents', 'branch', 'TEXT')
  ensureColumn(db, 'agents', 'profile_id', 'TEXT REFERENCES profiles(id) ON DELETE SET NULL')
  ensureColumn(db, 'agents', 'status', "TEXT NOT NULL DEFAULT 'idle'")
  ensureColumn(db, 'messages', 'message_id', 'TEXT')
  ensureColumn(db, 'messages', 'project_id', 'TEXT REFERENCES projects(id) ON DELETE CASCADE')
  ensureColumn(db, 'messages', 'status', "TEXT NOT NULL DEFAULT 'delivered'")
  ensureColumn(db, 'messages', 'attempts', 'INTEGER NOT NULL DEFAULT 0')
  ensureColumn(db, 'messages', 'last_error', 'TEXT')
  ensureColumn(db, 'tasks', 'mission_id', 'TEXT REFERENCES missions(id) ON DELETE SET NULL')
  ensureColumn(db, 'tasks', 'approval_status', "TEXT NOT NULL DEFAULT 'not_required'")
  ensureColumn(db, 'tasks', 'review_status', "TEXT NOT NULL DEFAULT 'pending'")
  ensureColumn(db, 'tasks', 'review_notes', 'TEXT')
  ensureColumn(db, 'tasks', 'blocked_reason', 'TEXT')
  ensureColumn(db, 'tasks', 'branch', 'TEXT')
  ensureColumn(db, 'tasks', 'budget_minutes', 'INTEGER')
  ensureColumn(db, 'tasks', 'source_type', 'TEXT')
  ensureColumn(db, 'tasks', 'source_ref', 'TEXT')
  ensureColumn(db, 'profiles', 'permissions_json', "TEXT NOT NULL DEFAULT '{}'")
  ensureColumn(db, 'memories', 'pinned', 'INTEGER NOT NULL DEFAULT 0')
  ensureColumn(db, 'memories', 'retention_days', 'INTEGER')
}
