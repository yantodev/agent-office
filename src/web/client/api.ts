type OfficeApi = Window['office']

type WebEvent = { type?: string; agentId?: string; id?: string; data?: string; exitCode?: number; status?: Agent['status'] }

export function createWebOfficeApi(baseUrl: string, token: string): OfficeApi {
  const terminalListeners = new Set<(payload: { id: string; data: string }) => void>()
  const exitListeners = new Set<(payload: { id: string; exitCode: number }) => void>()
  const stateListeners = new Set<(payload: { id: string; status: Agent['status'] }) => void>()
  let socket: WebSocket | null = null
  let socketPromise: Promise<WebSocket> | null = null
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null
  let subscribedProjectId: string | undefined

  const endpoint = (path: string) => `${baseUrl.replace(/\/$/, '')}${path}`
  async function request<T>(path: string, init: RequestInit = {}) {
    const response = await fetch(endpoint(path), {
      ...init,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...(init.headers ?? {}) },
    })
    const payload = await response.json().catch(() => ({})) as T & { error?: string }
    if (!response.ok) throw new Error(payload.error || `Web API request failed (${response.status})`)
    return payload as T
  }

  function json(method: string, payload: unknown): RequestInit { return { method, body: JSON.stringify(payload) } }

  async function webSocket() {
    if (socket?.readyState === WebSocket.OPEN) return socket
    if (socketPromise) return socketPromise
    socketPromise = new Promise<WebSocket>((resolve, reject) => {
      const url = new URL(endpoint('/v1/ws'), window.location.href)
      url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
      const current = new WebSocket(url, ['agent-office-v1', `bearer.${token}`])
      socket = current
      current.onopen = () => {
        socketPromise = null
        if (subscribedProjectId) current.send(JSON.stringify({ type: 'subscribe', projectId: subscribedProjectId }))
        resolve(current)
      }
      current.onerror = () => { socketPromise = null; socket = null; reject(new Error('WebSocket connection failed')) }
      current.onclose = () => {
        socket = null
        socketPromise = null
        if (terminalListeners.size || exitListeners.size || stateListeners.size) {
          if (reconnectTimer) clearTimeout(reconnectTimer)
          reconnectTimer = setTimeout(() => { reconnectTimer = null; void webSocket().catch(() => undefined) }, 1_000)
        }
      }
      current.onmessage = event => {
        try {
          const message = JSON.parse(String(event.data)) as WebEvent
          if (message.type === 'terminal.data' && message.agentId && typeof message.data === 'string') terminalListeners.forEach(listener => listener({ id: message.agentId!, data: message.data! }))
          if (message.type === 'agent.exit' && message.agentId && typeof message.exitCode === 'number') exitListeners.forEach(listener => listener({ id: message.agentId!, exitCode: message.exitCode! }))
          if (message.type === 'agent.state' && message.agentId && message.status) stateListeners.forEach(listener => listener({ id: message.agentId!, status: message.status! }))
        } catch { /* frame non-JSON diabaikan */ }
      }
    })
    return socketPromise
  }

  async function sendSocket(payload: Record<string, unknown>) {
    try { (await webSocket()).send(JSON.stringify(payload)) } catch { /* terminal bisa belum tersedia */ }
  }

  const api = {
    listProjects: () => request<Project[]>('/v1/projects'),
    listDirectories: (path?: string) => request<DirectoryListing>(`/v1/directories${path ? `?path=${encodeURIComponent(path)}` : ''}`),
    activeProject: async () => {
      const project = await request<Project | null>('/v1/active-project')
      subscribedProjectId = project?.id
      if (project) await sendSocket({ type: 'subscribe', projectId: project.id })
      return project
    },
    createProject: (project: { id: string; name: string; path: string; useWorktrees: boolean }) => request<Project>('/v1/projects', json('POST', project)),
    updateProject: (project: { id: string; name: string; path: string; useWorktrees: boolean }) => request<Project>(`/v1/projects/${encodeURIComponent(project.id)}`, json('PATCH', project)),
    setActiveProject: async (id: string) => {
      const project = await request<Project>(`/v1/projects/${encodeURIComponent(id)}/active`, json('POST', {}))
      subscribedProjectId = project.id
      await sendSocket({ type: 'subscribe', projectId: project.id })
      return project
    },
    removeProject: (id: string) => request<{ ok: boolean }>(`/v1/projects/${encodeURIComponent(id)}`, { method: 'DELETE' }).then(result => result.ok),
    listTasks: (projectId?: string) => projectId ? request<Task[]>(`/v1/projects/${encodeURIComponent(projectId)}/tasks`) : Promise.resolve([]),
    createTask: (task: Parameters<OfficeApi['createTask']>[0]) => request<Task>(`/v1/projects/${encodeURIComponent(task.projectId)}/tasks`, json('POST', task)),
    updateTask: (task: Parameters<OfficeApi['updateTask']>[0]) => request<Task>(`/v1/tasks/${encodeURIComponent(task.id)}`, json('PATCH', task)),
    addTaskArtifact: (artifact: Parameters<OfficeApi['addTaskArtifact']>[0]) => request<Task>(`/v1/tasks/${encodeURIComponent(artifact.taskId)}/artifacts`, json('POST', artifact)),
    setTaskReview: (review: Parameters<OfficeApi['setTaskReview']>[0]) => request<Task>(`/v1/tasks/${encodeURIComponent(review.taskId)}/review`, json('POST', review)),
    listMissions: (projectId?: string) => projectId ? request<Mission[]>(`/v1/projects/${encodeURIComponent(projectId)}/missions`) : Promise.resolve([]),
    createMission: async (mission: Parameters<OfficeApi['createMission']>[0]) => ({ mission: await request<Mission>(`/v1/projects/${encodeURIComponent(mission.projectId)}/missions`, json('POST', mission)), tasks: [] }),
    listSchedules: (projectId?: string) => projectId ? request<Schedule[]>(`/v1/projects/${encodeURIComponent(projectId)}/schedules`) : Promise.resolve([]),
    createSchedule: (schedule: Parameters<OfficeApi['createSchedule']>[0]) => request<Schedule>(`/v1/projects/${encodeURIComponent(schedule.projectId)}/schedules`, json('POST', schedule)),
    updateSchedule: (schedule: Parameters<OfficeApi['updateSchedule']>[0]) => request<Schedule>(`/v1/schedules/${encodeURIComponent(schedule.id)}`, json('PATCH', schedule)),
    removeSchedule: (id: string) => request<{ ok: boolean }>(`/v1/schedules/${encodeURIComponent(id)}`, { method: 'DELETE' }).then(result => result.ok),
    listApprovals: (projectId?: string) => projectId ? request<Approval[]>(`/v1/projects/${encodeURIComponent(projectId)}/approvals`) : Promise.resolve([]),
    resolveApproval: (approval: Parameters<OfficeApi['resolveApproval']>[0]) => request<{ ok: boolean }>(`/v1/approvals/${encodeURIComponent(approval.id)}/resolve`, json('POST', approval)).then(result => result.ok),
    prepareConfigChange: () => Promise.reject(new Error('CLI config changes are only available in the local Electron app')),
    applyConfigChange: () => Promise.reject(new Error('CLI config changes are only available in the local Electron app')),
    fleetSummary: (projectId?: string) => request<FleetSummary | null>(`/v1/fleet${projectId ? `?projectId=${encodeURIComponent(projectId)}` : ''}`),
    githubStatus: () => request<{ installed: boolean; authenticated: boolean }>('/v1/github/status'),
    importGithubIssues: () => request<Array<{ issueNumber: number; taskId: string; created: boolean }>>('/v1/github/import-issues', json('POST', {})),
    prepareGithubPr: () => Promise.reject(new Error('GitHub PR preparation requires the Electron local Git adapter')),
    createGithubPr: () => Promise.reject(new Error('GitHub PR creation requires the Electron local Git adapter')),
    listMessages: (projectId?: string) => projectId ? request<Message[]>(`/v1/projects/${encodeURIComponent(projectId)}/messages`) : Promise.resolve([]),
    sendMessage: (message: Parameters<OfficeApi['sendMessage']>[0]) => request<Message>(`/v1/projects/${encodeURIComponent(message.projectId)}/messages`, json('POST', message)),
    acknowledgeMessage: (message: Parameters<OfficeApi['acknowledgeMessage']>[0]) => request<{ ok: boolean }>(`/v1/messages/${encodeURIComponent(message.messageId)}/ack`, json('POST', message)).then(result => result.ok),
    listEvents: (projectId?: string) => projectId ? request<ActivityEvent[]>(`/v1/projects/${encodeURIComponent(projectId)}/events`) : Promise.resolve([]),
    listMemories: (input?: Parameters<OfficeApi['listMemories']>[0]) => input?.projectId ? request<Memory[]>(`/v1/projects/${encodeURIComponent(input.projectId)}/memories${input.query ? `?query=${encodeURIComponent(input.query)}` : ''}`) : Promise.resolve([]),
    semanticSearchMemories: (input: Parameters<OfficeApi['semanticSearchMemories']>[0]) => request<Memory[]>(`/v1/projects/${encodeURIComponent(input.projectId)}/memories?query=${encodeURIComponent(input.query)}`),
    saveMemory: (memory: Parameters<OfficeApi['saveMemory']>[0]) => request<Memory>(`/v1/projects/${encodeURIComponent(memory.projectId)}/memories`, json('POST', memory)),
    removeMemory: (id: string) => request<{ ok: boolean }>(`/v1/memories/${encodeURIComponent(id)}`, { method: 'DELETE' }).then(result => result.ok),
    pinMemory: (memory: Parameters<OfficeApi['pinMemory']>[0]) => request<{ ok: boolean }>(`/v1/memories/${encodeURIComponent(memory.id)}`, json('PATCH', memory)).then(result => result.ok),
    pruneMemories: () => Promise.resolve(0),
    listProfiles: () => request<AgentProfile[]>('/v1/profiles'),
    createProfile: (profile: Parameters<OfficeApi['createProfile']>[0]) => request<AgentProfile>('/v1/profiles', json('POST', profile)),
    updateProfile: (profile: Parameters<OfficeApi['updateProfile']>[0]) => request<AgentProfile>(`/v1/profiles/${encodeURIComponent(profile.id)}`, json('PATCH', profile)),
    removeProfile: (id: string) => request<{ ok: boolean }>(`/v1/profiles/${encodeURIComponent(id)}`, { method: 'DELETE' }).then(result => result.ok),
    listAgents: () => request<Agent[]>('/v1/agents'),
    createAgent: (agent: Parameters<OfficeApi['createAgent']>[0]) => agent.projectId ? request<Agent>(`/v1/projects/${encodeURIComponent(agent.projectId)}/agents`, json('POST', agent)) : request<Agent>('/v1/agents', json('POST', agent)),
    removeAgent: (id: string) => request<{ ok: boolean }>(`/v1/agents/${encodeURIComponent(id)}`, { method: 'DELETE' }).then(result => result.ok),
    startAgent: (agent: Agent & { taskId?: string; taskPrompt?: string }) => request<{ ok: boolean }>(`/v1/agents/${encodeURIComponent(agent.id)}/start`, json('POST', { taskId: agent.taskId })).then(result => result.ok),
    stopAgent: (id: string) => request<{ ok: boolean }>(`/v1/agents/${encodeURIComponent(id)}/stop`, json('POST', {})).then(result => result.ok),
    controlAgent: (input: Parameters<OfficeApi['controlAgent']>[0]) => request<{ ok: boolean }>(`/v1/agents/${encodeURIComponent(input.id)}/control`, json('POST', input)).then(result => result.ok),
    acquireCommitLock: () => Promise.reject(new Error('Git commit locks are only available in the Electron local adapter')),
    releaseCommitLock: () => Promise.reject(new Error('Git commit locks are only available in the Electron local adapter')),
    commit: () => Promise.reject(new Error('Git commit is only available in the Electron local adapter')),
    writeTerminal: (id: string, data: string) => { void sendSocket({ type: 'terminal.write', agentId: id, data }) },
    resizeTerminal: (id: string, cols: number, rows: number) => { void sendSocket({ type: 'terminal.resize', agentId: id, cols, rows }) },
    detectCli: () => request<CliInfo[]>('/v1/cli'),
    onTerminalData: (callback: (payload: { id: string; data: string }) => void) => { terminalListeners.add(callback); void webSocket(); return () => { terminalListeners.delete(callback) } },
    onAgentExit: (callback: (payload: { id: string; exitCode: number }) => void) => { exitListeners.add(callback); void webSocket(); return () => { exitListeners.delete(callback) } },
    onAgentState: (callback: (payload: { id: string; status: Agent['status'] }) => void) => { stateListeners.add(callback); void webSocket(); return () => { stateListeners.delete(callback) } },
  } as OfficeApi
  return api
}
