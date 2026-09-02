import { execFileSync } from 'node:child_process'

export function githubCli(cwd: string, args: string[]) {
  return execFileSync('gh', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}
