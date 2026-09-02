import fs from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { redactSecrets } from './security'

export type GitProject = {
  id: string
  path: string
  defaultBranch: string
  useWorktrees: number
}

export function git(cwd: string, args: string[]) {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

export function gitPreflight(cwd: string, baseBranch: string, headBranch: string) {
  // Bentuk three-tree kompatibel dengan Git lama, termasuk Git 2.34.
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

export function safePathSegment(value: string) {
  return value.replace(/[^A-Za-z0-9._-]/g, '-').replace(/^[.-]+|[.-]+$/g, '').slice(0, 64) || 'workspace'
}

export function gitBranch(path: string) {
  try { return git(path, ['branch', '--show-current']) || 'HEAD' } catch { return null }
}

export function createWorktree(project: GitProject, agentId: string, userDataPath: string) {
  if (!project.useWorktrees || !gitBranch(project.path)) return { cwd: project.path, worktreePath: null, branch: null }
  const worktreePath = join(userDataPath, 'worktrees', safePathSegment(project.id), safePathSegment(agentId))
  const branchBase = agentId.replace(/[^A-Za-z0-9._-]/g, '-').replace(/^[.-]+|[.-]+$/g, '').slice(0, 32) || 'worker'
  const branch = `agent/${branchBase}-${randomUUID().slice(0, 8)}`
  fs.mkdirSync(join(userDataPath, 'worktrees', project.id), { recursive: true })
  git(project.path, ['worktree', 'add', '-b', branch, worktreePath, project.defaultBranch])
  return { cwd: worktreePath, worktreePath, branch }
}

export function removeWorktree(project: GitProject | undefined, worktreePath: string | null | undefined) {
  if (!project || !worktreePath) return
  try { git(project.path, ['worktree', 'remove', worktreePath]) } catch { /* perubahan lokal tidak dihapus otomatis */ }
}
