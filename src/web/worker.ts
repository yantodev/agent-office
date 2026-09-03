import * as pty from 'node-pty'
import { statSync } from 'node:fs'
import { executionPlan, type ExecutionPermissions } from '../main/permission-policy.ts'
import { providerAdapter } from '../main/provider-adapters.ts'
import { filterSensitiveEnvironment, injectNineRouterEnvironment } from '../main/nine-router.ts'

export type WorkerStartInput = {
  id: string
  command: string
  cwd: string
  userDataPath: string
  permissions: ExecutionPermissions & { secrets?: boolean }
  environment?: Record<string, string>
}

export type WorkerRuntime = {
  start: (input: WorkerStartInput) => WorkerSession
  stop: (id: string) => boolean
  get: (id: string) => WorkerSession | undefined
}

export type WorkerSession = {
  id: string
  write: (data: string) => void
  resize: (cols: number, rows: number) => void
  stop: () => void
  onData: (listener: (data: string) => void) => () => void
  onExit: (listener: (exitCode: number) => void) => () => void
}

export function createLocalWorkerRuntime(): WorkerRuntime {
  const sessions = new Map<string, WorkerSession>()
  return {
    start(input) {
      if (sessions.has(input.id)) throw new Error('Worker session already exists')
      const cwd = input.cwd?.trim() || process.cwd()
      try {
        if (!statSync(cwd).isDirectory()) throw new Error('not a directory')
      } catch {
        throw new Error(`Working directory does not exist: ${cwd}`)
      }
      const adapter = providerAdapter(input.command)
      const baseEnvironment = filterSensitiveEnvironment({ ...process.env, ...input.environment } as Record<string, string>, input.permissions.secrets === true)
      const environment = injectNineRouterEnvironment(input.command, baseEnvironment)
      const plan = executionPlan({
        platform: process.platform,
        permissions: input.permissions,
        cwd,
        userDataPath: input.userDataPath,
        shell: process.platform === 'win32'
          ? { shell: 'powershell.exe', args: ['-NoLogo', '-NoProfile', '-Command', input.command] }
          : { shell: process.env.SHELL || '/bin/bash', args: ['-lc', input.command] },
        environment,
      })
      const term = pty.spawn(plan.file, plan.args, { name: 'xterm-256color', cols: 120, rows: 30, cwd, env: environment })
      const dataListeners = new Set<(data: string) => void>()
      const exitListeners = new Set<(exitCode: number) => void>()
      const session: WorkerSession = {
        id: input.id,
        write: data => term.write(data),
        resize: (cols, rows) => term.resize(cols, rows),
        stop: () => { term.kill(); sessions.delete(input.id) },
        onData: listener => { dataListeners.add(listener); return () => dataListeners.delete(listener) },
        onExit: listener => { exitListeners.add(listener); return () => exitListeners.delete(listener) },
      }
      term.onData(data => dataListeners.forEach(listener => listener(data)))
      term.onExit(({ exitCode }) => { sessions.delete(input.id); exitListeners.forEach(listener => listener(exitCode)) })
      sessions.set(input.id, session)
      return session
    },
    stop: id => {
      const session = sessions.get(id)
      if (!session) return false
      session.stop()
      return true
    },
    get: id => sessions.get(id),
  }
}
