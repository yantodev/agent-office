/// <reference types="vite/client" />

declare global {
  type Project = { id:string; name:string; path:string; defaultBranch:string; useWorktrees:number }
  type TaskStatus = 'backlog'|'assigned'|'running'|'blocked'|'review'|'done'|'failed'
  type TaskArtifact = { id:string; label:string; kind:string; location:string; metadata:Record<string, unknown>; createdAt:string }
  type TaskDependency = { id:string; title:string; status:TaskStatus }
  type Task = { id:string; projectId:string; title:string; prompt:string; status:TaskStatus; agentId?:string|null; agentName?:string|null; result?:string|null; error?:string|null; missionId?:string|null; approvalStatus?:'not_required'|'pending'|'approved'|'rejected'; reviewStatus?:'pending'|'approved'|'changes_requested'; reviewNotes?:string|null; blockedReason?:string|null; branch?:string|null; dependencies?:TaskDependency[]; artifacts?:TaskArtifact[] }
  type Mission = { id:string; projectId:string; title:string; request:string; status:string; createdAt:string; updatedAt?:string }
  type Schedule = { id:string; projectId:string; name:string; prompt:string; agentId?:string|null; agentName?:string|null; intervalMinutes:number; timezone:string; nextRunAt:string; enabled:number }
  type Approval = { id:string; projectId:string; taskId?:string|null; taskTitle?:string; type:string; title:string; reason:string; status:'pending'|'approved'|'rejected'; createdAt:string; resolvedAt?:string|null }
  type FleetSummary = { agents:{total:number;working:number;paused:number;errors:number}; tasks:{total:number;queued:number;running:number;errors:number}; approvals:{pending:number}; usage:{durationMs:number;outputBytes:number} }
  type Message = { id:string; projectId:string; fromAgent:string; toAgent:string; fromName?:string; toName?:string; body:string; status:string; attempts:number; lastError?:string|null; createdAt:string }
  type ActivityEvent = { id:string; projectId:string; agentId?:string|null; type:string; payload:Record<string, unknown>; createdAt:string }
  type Memory = { id:string; projectId:string; agentId?:string|null; agentName?:string|null; title:string; category:string; body:string; filePath:string; pinned:number; retentionDays?:number|null; createdAt:string; updatedAt:string }
  type AgentProfile = { id:string; name:string; role:string; command:string; soul:string; builtIn:number; permissions?:Record<string, boolean> }
  type Agent = { id:string; name:string; command:string; cwd:string; role:string; projectId?:string|null; projectName?:string; worktreePath?:string|null; branch?:string|null; dirty?:boolean; profileId?:string|null; profileName?:string; soul?:string; status:'idle'|'working'|'paused'|'error'|'offline' }
  type CliInfo = { command:string; installed:boolean; path:string|null }

  interface Window {
    office: {
      listProjects(): Promise<Project[]>
      activeProject(): Promise<Project|null>
      createProject(project: { id:string; name:string; path:string; useWorktrees:boolean }): Promise<Project>
      setActiveProject(id:string): Promise<Project>
      removeProject(id:string): Promise<boolean>
      listTasks(projectId?:string): Promise<Task[]>
      createTask(task: { id:string; projectId:string; title:string; prompt:string; agentId?:string|null; dependsOnTaskIds?:string[]; branch?:string|null }): Promise<Task>
      updateTask(task: { id:string; status?:TaskStatus; agentId?:string|null }): Promise<Task>
      addTaskArtifact(artifact: { taskId:string; label:string; kind?:string; location:string; metadata?:Record<string, unknown> }): Promise<Task>
      setTaskReview(review: { taskId:string; status:'pending'|'approved'|'changes_requested'; notes?:string }): Promise<Task>
      listMissions(projectId?:string): Promise<Mission[]>
      createMission(mission: { id:string; projectId:string; title?:string; request:string }): Promise<{ mission:Mission; tasks:Task[] }>
      listSchedules(projectId?:string): Promise<Schedule[]>
      createSchedule(schedule: { id:string; projectId:string; name:string; prompt:string; agentId?:string|null; intervalMinutes:number; timezone?:string; nextRunAt?:string }): Promise<Schedule>
      updateSchedule(schedule: { id:string; enabled?:boolean; intervalMinutes?:number; nextRunAt?:string }): Promise<Schedule>
      removeSchedule(id:string): Promise<boolean>
      listApprovals(projectId?:string): Promise<Approval[]>
      resolveApproval(approval: { id:string; status:'approved'|'rejected' }): Promise<boolean>
      prepareConfigChange(config: { projectId:string; path:string; content:string }): Promise<{ approvalId:string; path:string; diff:string }>
      applyConfigChange(approvalId:string): Promise<{ path:string; backupPath:string|null }>
      fleetSummary(projectId?:string): Promise<FleetSummary|null>
      githubStatus(projectId?:string): Promise<{ installed:boolean; authenticated:boolean }>
      importGithubIssues(projectId?:string): Promise<Array<{ issueNumber:number; taskId:string; created:boolean }>>
      prepareGithubPr(input: { taskId:string; title?:string; body?:string }): Promise<{ approvalId:string; diffStat:string }>
      createGithubPr(approvalId:string): Promise<{ url:string }>
      listMessages(projectId?:string): Promise<Message[]>
      sendMessage(message: { projectId:string; fromAgent:string; toAgent:string; body:string }): Promise<Message>
      acknowledgeMessage(message: { projectId:string; agentId:string; messageId:string }): Promise<boolean>
      listEvents(projectId?:string): Promise<ActivityEvent[]>
      listMemories(input?: { projectId?:string; query?:string }): Promise<Memory[]>
      semanticSearchMemories(input: { projectId:string; query:string }): Promise<Memory[]>
      saveMemory(memory: { id?:string; projectId:string; agentId?:string|null; title:string; category:string; body:string }): Promise<Memory>
      removeMemory(id:string): Promise<boolean>
      pinMemory(memory: { id:string; pinned:boolean }): Promise<boolean>
      pruneMemories(projectId?:string): Promise<number>
      listProfiles(): Promise<AgentProfile[]>
      createProfile(profile: Omit<AgentProfile,'builtIn'>): Promise<AgentProfile>
      updateProfile(profile: Omit<AgentProfile,'builtIn'>): Promise<AgentProfile>
      removeProfile(id:string): Promise<boolean>
      listAgents(): Promise<Agent[]>
      createAgent(agent: Omit<Agent,'status'>): Promise<Agent>
      removeAgent(id:string): Promise<boolean>
      startAgent(agent: Agent & { taskId?:string; taskPrompt?:string }): Promise<boolean>
      stopAgent(id:string): Promise<boolean>
      controlAgent(input: { id:string; action:'pause'|'resume'|'interrupt'|'steer'|'constrain'; text?:string }): Promise<boolean>
      acquireCommitLock(input: { projectId:string; agentId:string }): Promise<boolean>
      releaseCommitLock(input: { projectId:string; agentId:string }): Promise<boolean>
      commit(input: { agentId:string; message:string }): Promise<{ output:string; branch:string }>
      writeTerminal(id:string,data:string): void
      resizeTerminal(id:string,cols:number,rows:number): void
      detectCli(): Promise<CliInfo[]>
      onTerminalData(cb:(payload:{id:string;data:string})=>void):()=>void
      onAgentExit(cb:(payload:{id:string;exitCode:number})=>void):()=>void
      onAgentState(cb:(payload:{id:string;status:'idle'|'working'|'paused'|'error'|'offline'})=>void):()=>void
    }
  }
}
export {}
