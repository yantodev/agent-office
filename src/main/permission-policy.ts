import fs from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'

export type ExecutionPermissions = {
  filesystem: boolean
  network: boolean
  git: boolean
}

type ShellPlan = { shell: string; args: string[] }

function findBubblewrap() {
  try {
    return execFileSync('which', ['bwrap'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
  } catch {
    return ''
  }
}

function ensureGitDenyWrapper(userDataPath: string) {
  const binPath = join(userDataPath, 'permission-sandbox', 'bin')
  fs.mkdirSync(binPath, { recursive: true, mode: 0o700 })
  const wrapperPath = join(binPath, 'git')
  if (!fs.existsSync(wrapperPath)) {
    fs.writeFileSync(wrapperPath, '#!/bin/sh\nprintf "%s\\n" "Git is disabled by the Agent Office permission profile." >&2\nexit 126\n', { mode: 0o700 })
  }
  return { binPath, wrapperPath }
}

export function executionPlan(input: {
  platform: NodeJS.Platform
  permissions: ExecutionPermissions
  cwd: string
  userDataPath: string
  shell: ShellPlan
  environment: Record<string, string>
}) {
  const restricted = !input.permissions.filesystem || !input.permissions.network || !input.permissions.git
  if (!restricted) return { file: input.shell.shell, args: input.shell.args, environment: input.environment, sandboxed: false }
  if (input.platform !== 'linux') throw new Error('Restricted agent profiles require a supported Linux sandbox (bubblewrap)')

  const bubblewrap = findBubblewrap()
  if (!bubblewrap) throw new Error('Restricted agent profiles require bubblewrap (bwrap) on Linux')

  const denyGit = input.permissions.git ? undefined : ensureGitDenyWrapper(input.userDataPath)
  const path = denyGit ? `${denyGit.binPath}:${input.environment.PATH || '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin'}` : input.environment.PATH
  const args = [
    '--die-with-parent',
    '--new-session',
    '--ro-bind', '/', '/',
    '--dev', '/dev',
    '--proc', '/proc',
    '--tmpfs', '/tmp',
    '--bind', input.cwd, input.cwd,
    '--setenv', 'AGENT_OFFICE_SANDBOXED', '1',
  ]
  if (denyGit) {
    args.push('--ro-bind', denyGit.binPath, denyGit.binPath, '--setenv', 'PATH', path)
    for (const gitPath of ['/usr/bin/git', '/bin/git', '/usr/local/bin/git']) {
      if (fs.existsSync(gitPath)) args.push('--ro-bind', denyGit.wrapperPath, gitPath)
    }
  }
  if (!input.permissions.network) args.push('--unshare-net')
  args.push('--', input.shell.shell, ...input.shell.args)
  return { file: bubblewrap, args, environment: input.environment, sandboxed: true }
}
