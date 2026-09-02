import pty from 'node-pty'
import { executionPlan, type ExecutionPermissions } from './permission-policy'
import { providerAdapter } from './provider-adapters'

type ShellPlan = { shell: string; args: string[] }

export function spawnAgentSession(input: {
  shell: ShellPlan
  cwd: string
  userDataPath: string
  permissions: ExecutionPermissions
  command: string
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
  const adapter = providerAdapter(input.command)
  return pty.spawn(plan.file, plan.args, {
    name: 'xterm-256color',
    cols: 120,
    rows: 30,
    cwd: input.cwd,
    env: adapter.injectContext({
      ...input.environment,
      AGENT_OFFICE_PROFILE: input.profileName ?? '',
      AGENT_OFFICE_TASK_ID: input.taskId ?? '',
    }, input.soul, input.taskPrompt) as Record<string, string>
  })
}

export function submitAgentPrompt(session: pty.IPty, command: string, prompt: string) {
  session.write(providerAdapter(command).submitPrompt(prompt))
}

export function interruptAgent(session: pty.IPty, command: string) {
  session.write(providerAdapter(command).interrupt)
}
