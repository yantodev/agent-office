export type TaskStatus = 'backlog' | 'assigned' | 'running' | 'blocked' | 'review' | 'done' | 'failed'

export type BlockedReason = 'approval' | 'dependencies' | 'manual' | 'review' | null

const taskStatuses = ['backlog', 'assigned', 'running', 'blocked', 'review', 'done', 'failed'] as const

const taskTransitions: Record<TaskStatus, readonly TaskStatus[]> = {
  backlog: ['assigned', 'blocked', 'review'],
  assigned: ['backlog', 'blocked', 'running', 'review'],
  running: ['blocked', 'review', 'failed'],
  blocked: ['backlog', 'assigned', 'running'],
  review: ['blocked', 'done', 'running'],
  done: [],
  failed: ['backlog', 'assigned', 'running']
}

export function isTaskStatus(value: unknown): value is TaskStatus {
  return typeof value === 'string' && (taskStatuses as readonly string[]).includes(value)
}

export function assertTaskTransition(current: TaskStatus, next: TaskStatus) {
  if (current === next) return
  if (!taskTransitions[current].includes(next)) throw new Error(`Invalid task transition: ${current} -> ${next}`)
}

export function resolveTaskReadiness(
  agentId: string | null | undefined,
  dependenciesReady: boolean,
  approvalPending: boolean
) {
  if (approvalPending) return { status: 'blocked' as const, blockedReason: 'approval' as const }
  if (!dependenciesReady) return { status: 'blocked' as const, blockedReason: 'dependencies' as const }
  return { status: agentId ? 'assigned' as const : 'backlog' as const, blockedReason: null }
}
