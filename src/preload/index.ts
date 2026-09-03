import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('office', {
  listProjects: () => ipcRenderer.invoke('projects:list'),
  listDirectories: (path?: string) => ipcRenderer.invoke('directories:list', path),
  activeProject: () => ipcRenderer.invoke('projects:active'),
  createProject: (project: unknown) => ipcRenderer.invoke('projects:create', project),
  updateProject: (project: unknown) => ipcRenderer.invoke('projects:update', project),
  setActiveProject: (id: string) => ipcRenderer.invoke('projects:set-active', id),
  removeProject: (id: string) => ipcRenderer.invoke('projects:remove', id),
  listTasks: (projectId?: string) => ipcRenderer.invoke('tasks:list', projectId),
  createTask: (task: unknown) => ipcRenderer.invoke('tasks:create', task),
  updateTask: (task: unknown) => ipcRenderer.invoke('tasks:update', task),
  addTaskArtifact: (artifact: unknown) => ipcRenderer.invoke('tasks:add-artifact', artifact),
  setTaskReview: (review: unknown) => ipcRenderer.invoke('tasks:set-review', review),
  listMissions: (projectId?: string) => ipcRenderer.invoke('missions:list', projectId),
  createMission: (mission: unknown) => ipcRenderer.invoke('missions:create', mission),
  listSchedules: (projectId?: string) => ipcRenderer.invoke('schedules:list', projectId),
  createSchedule: (schedule: unknown) => ipcRenderer.invoke('schedules:create', schedule),
  updateSchedule: (schedule: unknown) => ipcRenderer.invoke('schedules:update', schedule),
  removeSchedule: (id: string) => ipcRenderer.invoke('schedules:remove', id),
  listApprovals: (projectId?: string) => ipcRenderer.invoke('approvals:list', projectId),
  resolveApproval: (approval: unknown) => ipcRenderer.invoke('approvals:resolve', approval),
  prepareConfigChange: (config: unknown) => ipcRenderer.invoke('config:prepare', config),
  applyConfigChange: (approvalId: string) => ipcRenderer.invoke('config:apply', approvalId),
  fleetSummary: (projectId?: string) => ipcRenderer.invoke('fleet:summary', projectId),
  githubStatus: (projectId?: string) => ipcRenderer.invoke('github:status', projectId),
  nineRouterHealth: () => ipcRenderer.invoke('nine-router:health'),
  configureNineRouter: (config: unknown) => ipcRenderer.invoke('nine-router:configure', config),
  importGithubIssues: (projectId?: string) => ipcRenderer.invoke('github:import-issues', projectId),
  prepareGithubPr: (input: unknown) => ipcRenderer.invoke('github:prepare-pr', input),
  createGithubPr: (approvalId: string) => ipcRenderer.invoke('github:create-pr', approvalId),
  listMessages: (projectId?: string) => ipcRenderer.invoke('messages:list', projectId),
  sendMessage: (message: unknown) => ipcRenderer.invoke('messages:send', message),
  acknowledgeMessage: (message: unknown) => ipcRenderer.invoke('messages:ack', message),
  listEvents: (projectId?: string) => ipcRenderer.invoke('events:list', projectId),
  listMemories: (input?: unknown) => ipcRenderer.invoke('memories:list', input),
  semanticSearchMemories: (input: unknown) => ipcRenderer.invoke('memories:semantic-search', input),
  saveMemory: (memory: unknown) => ipcRenderer.invoke('memories:save', memory),
  removeMemory: (id: string) => ipcRenderer.invoke('memories:remove', id),
  pinMemory: (memory: unknown) => ipcRenderer.invoke('memories:pin', memory),
  pruneMemories: (projectId?: string) => ipcRenderer.invoke('memories:prune', projectId),
  listProfiles: () => ipcRenderer.invoke('profiles:list'),
  createProfile: (profile: unknown) => ipcRenderer.invoke('profiles:create', profile),
  updateProfile: (profile: unknown) => ipcRenderer.invoke('profiles:update', profile),
  removeProfile: (id: string) => ipcRenderer.invoke('profiles:remove', id),
  listAgents: () => ipcRenderer.invoke('agents:list'),
  createAgent: (agent: unknown) => ipcRenderer.invoke('agents:create', agent),
  removeAgent: (id: string) => ipcRenderer.invoke('agents:remove', id),
  startAgent: (agent: unknown) => ipcRenderer.invoke('agent:start', agent),
  stopAgent: (id: string) => ipcRenderer.invoke('agent:stop', id),
  controlAgent: (input: unknown) => ipcRenderer.invoke('agent:control', input),
  acquireCommitLock: (input: unknown) => ipcRenderer.invoke('git:acquire-commit-lock', input),
  releaseCommitLock: (input: unknown) => ipcRenderer.invoke('git:release-commit-lock', input),
  commit: (input: unknown) => ipcRenderer.invoke('git:commit', input),
  writeTerminal: (id: string, data: string) => ipcRenderer.send('terminal:write', { id, data }),
  resizeTerminal: (id: string, cols: number, rows: number) => ipcRenderer.send('terminal:resize', { id, cols, rows }),
  getTerminalBuffer: (id: string) => ipcRenderer.invoke('agent:terminal-buffer', id),
  detectCli: () => ipcRenderer.invoke('system:detectCli'),
  onTerminalData: (cb: (payload: { id: string; data: string }) => void) => {
    const fn = (_: unknown, payload: { id: string; data: string }) => cb(payload)
    ipcRenderer.on('terminal:data', fn)
    return () => ipcRenderer.removeListener('terminal:data', fn)
  },
  onAgentExit: (cb: (payload: { id: string; exitCode: number }) => void) => {
    const fn = (_: unknown, payload: { id: string; exitCode: number }) => cb(payload)
    ipcRenderer.on('agent:exit', fn)
    return () => ipcRenderer.removeListener('agent:exit', fn)
  },
  onAgentState: (cb: (payload: { id: string; status: 'idle' | 'working' | 'paused' | 'error' | 'offline' }) => void) => {
    const fn = (_: unknown, payload: { id: string; status: 'idle' | 'working' | 'paused' | 'error' | 'offline' }) => cb(payload)
    ipcRenderer.on('agent:state', fn)
    return () => ipcRenderer.removeListener('agent:state', fn)
  }
})
