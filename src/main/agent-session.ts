import pty from 'node-pty'
import { executionPlan, type ExecutionPermissions } from './permission-policy'

type ShellPlan = { shell: string; args: string[] }

export function spawnAgentSession(input: {
  shell: ShellPlan
  cwd: string
  userDataPath: string
  permissions: ExecutionPermissions
  environment: Record<string, string>
  profileName?: string
  soul: string
  taskId?: string
  taskPrompt: string
}) {
  const plan = executionPlan({
    platform: process.platform,
    permissions: input.permissions,
    cwd: input.cwd,
    userDataPath: input.userDataPath,
    shell: input.shell,
    environment: input.environment,
  })
  return pty.spawn(plan.file, plan.args, {
    name: 'xterm-256color',
    cols: 120,
    rows: 30,
    cwd: input.cwd,
    env: {
      ...input.environment,
      AGENT_OFFICE_PROFILE: input.profileName ?? '',
      AGENT_OFFICE_SOUL: input.soul,
      AGENT_OFFICE_TASK_ID: input.taskId ?? '',
      AGENT_OFFICE_TASK_PROMPT: input.taskPrompt,
    } as Record<string, string>
  })
}
