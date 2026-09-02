import React, { useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { TerminalPanel } from './components/TerminalPanel'
import { OfficeFloor } from './components/OfficeFloor'
import logoLandscapeUrl from '../../../assets/logo/logo-landscape.png?url'
import './styles/app.css'

const defaultPermissions = { filesystem: true, network: true, shell: true, git: true, secrets: false }
const emptyProfile = { name: '', role: '', command: 'codex', soul: '', permissions: defaultPermissions }
const taskColumns: Array<{ status: TaskStatus; label: string }> = [
  { status: 'backlog', label: 'Backlog' },
  { status: 'assigned', label: 'Assigned' },
  { status: 'running', label: 'Running' },
  { status: 'blocked', label: 'Blocked' },
  { status: 'review', label: 'Review' },
  { status: 'done', label: 'Done' },
  { status: 'failed', label: 'Failed' },
]

function CommandCenter({ project, agents }: { project: Project | null; agents: Agent[] }) {
  const [tasks, setTasks] = useState<Task[]>([])
  const [messages, setMessages] = useState<Message[]>([])
  const [events, setEvents] = useState<ActivityEvent[]>([])
  const [missions, setMissions] = useState<Mission[]>([])
  const [schedules, setSchedules] = useState<Schedule[]>([])
  const [approvals, setApprovals] = useState<Approval[]>([])
  const [github, setGithub] = useState<{ installed:boolean; authenticated:boolean }>({ installed:false, authenticated:false })
  const [githubMessage, setGithubMessage] = useState('')
  const [title, setTitle] = useState('')
  const [prompt, setPrompt] = useState('')
  const [agentId, setAgentId] = useState('')
  const [dependencyIds, setDependencyIds] = useState<string[]>([])
  const [missionTitle, setMissionTitle] = useState('')
  const [missionRequest, setMissionRequest] = useState('')
  const [scheduleName, setScheduleName] = useState('')
  const [schedulePrompt, setSchedulePrompt] = useState('')
  const [scheduleInterval, setScheduleInterval] = useState('60')
  const [scheduleAgentId, setScheduleAgentId] = useState('')
  const [fromAgent, setFromAgent] = useState('')
  const [toAgent, setToAgent] = useState('')
  const [messageBody, setMessageBody] = useState('')

  const refreshCoordination = async () => {
    if (!project) { setTasks([]); setMessages([]); setEvents([]); setMissions([]); setSchedules([]); setApprovals([]); return }
    const [nextTasks, nextMessages, nextEvents, nextMissions, nextSchedules, nextApprovals, nextGithub] = await Promise.all([
      window.office.listTasks(project.id),
      window.office.listMessages(project.id),
      window.office.listEvents(project.id),
      window.office.listMissions(project.id),
      window.office.listSchedules(project.id),
      window.office.listApprovals(project.id),
      window.office.githubStatus(project.id)
    ])
    setTasks(nextTasks)
    setMessages(nextMessages)
    setEvents(nextEvents)
    setMissions(nextMissions)
    setSchedules(nextSchedules)
    setApprovals(nextApprovals)
    setGithub(nextGithub)
  }
  useEffect(() => { refreshCoordination() }, [project?.id])

  async function createTask(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!project || !title.trim() || !prompt.trim()) return
    await window.office.createTask({ id: crypto.randomUUID(), projectId: project.id, title, prompt, agentId: agentId || null, dependsOnTaskIds: dependencyIds })
    setTitle('')
    setPrompt('')
    setAgentId('')
    setDependencyIds([])
    await refreshCoordination()
  }

  async function createMission(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!project || !missionRequest.trim()) return
    await window.office.createMission({ id: crypto.randomUUID(), projectId: project.id, title: missionTitle, request: missionRequest })
    setMissionTitle('')
    setMissionRequest('')
    await refreshCoordination()
  }

  async function createSchedule(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!project || !scheduleName.trim() || !schedulePrompt.trim()) return
    await window.office.createSchedule({ id: crypto.randomUUID(), projectId: project.id, name: scheduleName, prompt: schedulePrompt, agentId: scheduleAgentId || null, intervalMinutes: Number(scheduleInterval), timezone: Intl.DateTimeFormat().resolvedOptions().timeZone })
    setScheduleName('')
    setSchedulePrompt('')
    await refreshCoordination()
  }

  async function resolveApproval(approval: Approval, status: 'approved' | 'rejected') {
    await window.office.resolveApproval({ id: approval.id, status })
    await refreshCoordination()
  }

  async function importGithubIssues() {
    if (!project) return
    const imported = await window.office.importGithubIssues(project.id)
    setGithubMessage(`${imported.length} open issue(s) synchronized.`)
    await refreshCoordination()
  }

  async function updateTask(task: Task, status: TaskStatus) {
    await window.office.updateTask({ id: task.id, status })
    await refreshCoordination()
  }

  async function assignTask(task: Task, nextAgentId: string) {
    await window.office.updateTask({ id: task.id, agentId: nextAgentId || null, status: nextAgentId ? 'assigned' : 'backlog' })
    await refreshCoordination()
  }

  async function runTask(task: Task) {
    const agent = agents.find(value => value.id === task.agentId)
    if (!agent) return
    await window.office.startAgent({ ...agent, taskId: task.id, taskPrompt: task.prompt })
    await refreshCoordination()
  }

  async function sendMessage(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!project || !fromAgent || !toAgent || !messageBody.trim()) return
    await window.office.sendMessage({ projectId: project.id, fromAgent, toAgent, body: messageBody })
    setMessageBody('')
    await refreshCoordination()
  }

  return <section className="command-center">
    <div className="command-header"><div><h2>Command Center</h2><p>{project ? `Tasks for ${project.name}` : 'Select a workspace first.'}</p></div><span className="task-count">{tasks.length} tasks</span></div>
    <div className="command-panels">
      <form className="mission-form panel-card" onSubmit={createMission}>
        <div className="panel-title"><h3>New mission</h3><span>{missions.length} missions</span></div>
        <input aria-label="Mission title" placeholder="Mission title (optional)" value={missionTitle} onChange={event => setMissionTitle(event.target.value)} />
        <textarea aria-label="Mission request" placeholder="Describe the goal. Use bullet points for deterministic task decomposition." rows={4} value={missionRequest} onChange={event => setMissionRequest(event.target.value)} />
        <button className="save-profile" type="submit" disabled={!project}>Decompose mission</button>
      </form>
      <form className="schedule-form panel-card" onSubmit={createSchedule}>
        <div className="panel-title"><h3>Scheduled mission</h3><span>UTC-safe next run</span></div>
        <input aria-label="Schedule name" placeholder="Schedule name" value={scheduleName} onChange={event => setScheduleName(event.target.value)} />
        <textarea aria-label="Schedule prompt" placeholder="Heartbeat or recurring task prompt" rows={2} value={schedulePrompt} onChange={event => setSchedulePrompt(event.target.value)} />
        <div className="schedule-fields"><input aria-label="Interval minutes" type="number" min="1" value={scheduleInterval} onChange={event => setScheduleInterval(event.target.value)} /><select aria-label="Schedule agent" value={scheduleAgentId} onChange={event => setScheduleAgentId(event.target.value)}><option value="">Unassigned</option>{agents.map(agent => <option key={agent.id} value={agent.id}>{agent.name}</option>)}</select></div>
        <button className="save-profile" type="submit" disabled={!project}>Create schedule</button>
      </form>
      <div className="github-form panel-card"><div className="panel-title"><h3>GitHub bridge</h3><span>{github.authenticated ? 'authenticated' : github.installed ? 'login required' : 'gh missing'}</span></div><p className="muted">Sync issues as durable tasks. PR creation always waits for approval.</p><button className="save-profile" type="button" onClick={importGithubIssues} disabled={!project || !github.authenticated}>Sync issues</button>{githubMessage && <small className="muted">{githubMessage}</small>}</div>
    </div>
    <form className="task-form" onSubmit={createTask}>
      <input aria-label="Task title" placeholder="Task title" value={title} onChange={event => setTitle(event.target.value)} />
      <select aria-label="Assign agent" value={agentId} onChange={event => setAgentId(event.target.value)}><option value="">Unassigned</option>{agents.map(agent => <option key={agent.id} value={agent.id}>{agent.name}</option>)}</select>
      <select aria-label="Task dependencies" multiple value={dependencyIds} onChange={event => setDependencyIds(Array.from(event.target.selectedOptions, option => option.value))}>{tasks.filter(task => task.status !== 'done').map(task => <option key={task.id} value={task.id}>{task.title}</option>)}</select>
      <textarea aria-label="Task prompt" placeholder="Describe the work the agent should perform" rows={3} value={prompt} onChange={event => setPrompt(event.target.value)} />
      <button className="save-profile" type="submit" disabled={!project}>Create task</button>
    </form>
    <div className="kanban-board">
      {taskColumns.map(column => <div className="kanban-column" key={column.status}>
        <div className="column-title"><h3>{column.label}</h3><span>{tasks.filter(task => task.status === column.status).length}</span></div>
        <div className="task-list">{tasks.filter(task => task.status === column.status).map(task => <article className={`task-card task-${task.status}`} key={task.id}>
          <strong>{task.title}</strong><p>{task.prompt}</p>
          <div className="task-badges">{task.approvalStatus === 'pending' && <span className="badge-warning">Approval pending</span>}{task.blockedReason && <span>Blocked: {task.blockedReason}</span>}{task.dependencies && task.dependencies.length > 0 && <span>{task.dependencies.length} dependency</span>}{task.artifacts && task.artifacts.length > 0 && <span>{task.artifacts.length} artifact</span>}{task.branch && <span>{task.branch}</span>}</div>
          {(task.result || task.error || task.reviewNotes) && <details className="task-details"><summary>Output / review</summary><pre>{task.error || task.reviewNotes || task.result}</pre></details>}
          <select aria-label={`Assign ${task.title}`} value={task.agentId ?? ''} onChange={event => assignTask(task, event.target.value)}><option value="">Unassigned</option>{agents.map(agent => <option key={agent.id} value={agent.id}>{agent.name}</option>)}</select>
          <div className="task-meta"><span>{task.agentName ?? 'No agent'}{task.reviewStatus === 'changes_requested' ? ' · changes requested' : ''}</span>{task.status === 'assigned' && <button onClick={() => runTask(task)}>Run</button>}{task.status === 'running' && <button onClick={() => updateTask(task, 'blocked')}>Block</button>}{task.status === 'failed' && <button onClick={() => updateTask(task, 'assigned')}>Retry</button>}{task.status === 'review' && <><button onClick={() => window.office.setTaskReview({ taskId: task.id, status: 'approved' }).then(refreshCoordination)}>Approve</button><button onClick={() => window.office.prepareGithubPr({ taskId: task.id }).then(() => refreshCoordination())}>Prepare PR</button></>}</div>
        </article>)}</div>
      </div>)}
    </div>
    <div className="coordination-grid">
      <div className="panel-card"><div className="panel-title"><h3>Approval queue</h3><span>{approvals.filter(approval => approval.status === 'pending').length} pending</span></div><div className="approval-list">{approvals.slice(0, 8).map(approval => <div className="approval-row" key={approval.id}><strong>{approval.title}</strong><p>{approval.reason}</p>{approval.status === 'pending' && <div className="profile-actions"><button onClick={() => resolveApproval(approval, 'approved')}>Approve</button><button onClick={() => resolveApproval(approval, 'rejected')}>Reject</button></div>}{approval.status === 'approved' && approval.type === 'github-pr' && <button onClick={() => window.office.createGithubPr(approval.id).then(() => refreshCoordination())}>Create PR</button>}</div>)}</div></div>
      <div className="panel-card"><div className="panel-title"><h3>Schedules</h3><span>{schedules.filter(schedule => schedule.enabled).length} active</span></div><div className="schedule-list">{schedules.slice(0, 8).map(schedule => <div className="schedule-row" key={schedule.id}><div><strong>{schedule.name}</strong><small>{schedule.agentName ?? 'Unassigned'} · every {schedule.intervalMinutes}m · next {new Date(schedule.nextRunAt).toLocaleString()}</small></div><button onClick={() => window.office.updateSchedule({ id: schedule.id, enabled: !schedule.enabled }).then(refreshCoordination)}>{schedule.enabled ? 'Pause' : 'Resume'}</button><button onClick={() => window.office.removeSchedule(schedule.id).then(refreshCoordination)}>Delete</button></div>)}</div></div>
    </div>
    <div className="coordination-grid">
      <div className="panel-card">
        <div className="panel-title"><h3>Mailbox</h3><span>{messages.length} messages</span></div>
        <form className="message-form" onSubmit={sendMessage}>
          <select aria-label="Message sender" value={fromAgent} onChange={event => setFromAgent(event.target.value)}><option value="">From agent</option>{agents.map(agent => <option key={agent.id} value={agent.id}>{agent.name}</option>)}</select>
          <select aria-label="Message recipient" value={toAgent} onChange={event => setToAgent(event.target.value)}><option value="">To agent</option>{agents.filter(agent => agent.id !== fromAgent).map(agent => <option key={agent.id} value={agent.id}>{agent.name}</option>)}</select>
          <textarea aria-label="Message body" placeholder="Send a durable message to another agent" rows={3} value={messageBody} onChange={event => setMessageBody(event.target.value)} />
          <button className="save-profile" type="submit">Send message</button>
        </form>
        <div className="message-list">{messages.slice(0, 8).map(message => <div className="message-row" key={message.id}><strong>{message.fromName ?? message.fromAgent} → {message.toName ?? message.toAgent}</strong><p>{message.body}</p></div>)}</div>
      </div>
      <div className="panel-card">
        <div className="panel-title"><h3>Activity log</h3><span>{events.length} events</span></div>
        <div className="event-list">{events.slice(0, 12).map(event => <div className="event-row" key={event.id}><code>{event.type}</code><span>{new Date(event.createdAt).toLocaleTimeString()}</span></div>)}</div>
      </div>
    </div>
  </section>
}

const emptyMemory = { title: '', category: 'general', body: '', agentId: '' }

function MemoryCenter({ project, agents }: { project: Project | null; agents: Agent[] }) {
  const [memories, setMemories] = useState<Memory[]>([])
  const [query, setQuery] = useState('')
  const [semantic, setSemantic] = useState(false)
  const [draft, setDraft] = useState(emptyMemory)
  const [editingId, setEditingId] = useState<string | undefined>()

  const refreshMemories = () => project ? (semantic ? window.office.semanticSearchMemories({ projectId: project.id, query }).then(setMemories) : window.office.listMemories({ projectId: project.id, query }).then(setMemories)) : Promise.resolve()
  useEffect(() => { refreshMemories() }, [project?.id, query, semantic])

  async function saveMemory(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!project || !draft.title.trim() || !draft.body.trim()) return
    await window.office.saveMemory({ id: editingId, projectId: project.id, agentId: draft.agentId || null, title: draft.title, category: draft.category, body: draft.body })
    setDraft(emptyMemory)
    setEditingId(undefined)
    await refreshMemories()
  }

  function editMemory(memory: Memory) {
    setEditingId(memory.id)
    setDraft({ title: memory.title, category: memory.category, body: memory.body, agentId: memory.agentId ?? '' })
  }

  async function removeMemory(memory: Memory) {
    if (!window.confirm(`Delete memory ${memory.title}?`)) return
    await window.office.removeMemory(memory.id)
    await refreshMemories()
  }

  return <section className="memory-center">
    <div className="command-header"><div><h2>Shared Memory</h2><p>{project ? `Markdown knowledge for ${project.name}` : 'Select a workspace first.'}</p></div><span className="task-count">{memories.length} entries</span></div>
    <div className="memory-layout">
      <div className="panel-card">
        <div className="panel-title"><h3>{editingId ? 'Edit memory' : 'New memory'}</h3>{editingId && <button className="link-button" onClick={() => { setEditingId(undefined); setDraft(emptyMemory) }}>Cancel</button>}</div>
        <form className="profile-form" onSubmit={saveMemory}>
          <input aria-label="Memory title" placeholder="Title" value={draft.title} onChange={event => setDraft({ ...draft, title: event.target.value })} />
          <input aria-label="Memory category" placeholder="Category" value={draft.category} onChange={event => setDraft({ ...draft, category: event.target.value })} />
          <select aria-label="Memory agent" value={draft.agentId} onChange={event => setDraft({ ...draft, agentId: event.target.value })}><option value="">Shared memory</option>{agents.map(agent => <option key={agent.id} value={agent.id}>{agent.name}</option>)}</select>
          <textarea aria-label="Memory body" placeholder="Write a decision, fact, error, or useful context" rows={12} value={draft.body} onChange={event => setDraft({ ...draft, body: event.target.value })} />
          <button className="save-profile" type="submit" disabled={!project}>Save memory</button>
        </form>
      </div>
      <div className="panel-card memory-browser">
        <input className="memory-search" aria-label="Search memory" placeholder="Search memory" value={query} onChange={event => setQuery(event.target.value)} /><label className="checkbox-row memory-mode"><input type="checkbox" checked={semantic} onChange={event => setSemantic(event.target.checked)} /> Local semantic vector search</label>
        <div className="memory-list">{memories.map(memory => <article className="memory-card" key={memory.id}><div className="panel-title"><strong>{memory.title}</strong><span>{memory.category}{memory.pinned ? ' · pinned' : ''}</span></div><small>{memory.agentName ?? 'Shared'} · {new Date(memory.updatedAt).toLocaleString()}</small><p>{memory.body}</p><div className="profile-actions"><button type="button" onClick={() => editMemory(memory)}>Edit</button><button type="button" onClick={() => window.office.pinMemory({ id: memory.id, pinned: !Boolean(memory.pinned) }).then(refreshMemories)}>{memory.pinned ? 'Unpin' : 'Pin'}</button><button type="button" onClick={() => removeMemory(memory)}>Delete</button></div></article>)}</div>
      </div>
    </div>
  </section>
}

function SettingsCenter({ project }: { project: Project | null }) {
  const [configPath, setConfigPath] = useState('')
  const [configContent, setConfigContent] = useState('')
  const [diff, setDiff] = useState('')
  const [approvals, setApprovals] = useState<Approval[]>([])
  const [notice, setNotice] = useState('')
  const refresh = () => project ? window.office.listApprovals(project.id).then(setApprovals) : Promise.resolve()
  useEffect(() => { setDiff(''); setNotice(''); refresh() }, [project?.id])

  async function prepare(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!project || !configPath.trim()) return
    const result = await window.office.prepareConfigChange({ projectId: project.id, path: configPath, content: configContent })
    setDiff(result.diff)
    setNotice(`Approval request created: ${result.approvalId}`)
    await refresh()
  }

  async function resolve(approval: Approval, status: 'approved' | 'rejected') {
    await window.office.resolveApproval({ id: approval.id, status })
    await refresh()
  }

  async function apply(approval: Approval) {
    const result = await window.office.applyConfigChange(approval.id)
    setNotice(result.backupPath ? `Applied. Backup: ${result.backupPath}` : 'Applied new config file.')
    await refresh()
  }

  return <section className="settings-center">
    <div className="command-header"><div><h2>Settings & safety</h2><p>{project ? 'Preview and approve CLI configuration changes.' : 'Select a workspace first.'}</p></div></div>
    <div className="settings-layout">
      <form className="panel-card profile-form" onSubmit={prepare}><h3>CLI config change</h3><input aria-label="CLI config path" placeholder="Absolute CLI config path" value={configPath} onChange={event => setConfigPath(event.target.value)} /><textarea aria-label="CLI config content" placeholder="Proposed complete file content" rows={14} value={configContent} onChange={event => setConfigContent(event.target.value)} /><small className="muted">The current file is backed up before replacement. Secret values are redacted in the diff and event log.</small><button className="save-profile" type="submit" disabled={!project}>Preview & request approval</button>{diff && <pre className="config-diff">{diff}</pre>}{notice && <small className="muted">{notice}</small>}</form>
      <div className="panel-card"><div className="panel-title"><h3>Config approvals</h3><span>{approvals.filter(approval => approval.type === 'config-change' && approval.status === 'pending').length} pending</span></div><div className="approval-list">{approvals.filter(approval => approval.type === 'config-change').map(approval => <div className="approval-row" key={approval.id}><strong>{approval.title}</strong><p>{approval.reason}</p>{approval.status === 'pending' && <div className="profile-actions"><button onClick={() => resolve(approval, 'approved')}>Approve</button><button onClick={() => resolve(approval, 'rejected')}>Reject</button></div>}{approval.status === 'approved' && <button onClick={() => apply(approval)}>Apply backed-up change</button>}</div>)}</div></div>
    </div>
  </section>
}

type AppView = 'dashboard' | 'floor' | 'agents' | 'workspaces' | 'command' | 'inbox' | 'github' | 'memory' | 'settings'

function DashboardCenter({ project, agents, fleet, onSelect }: { project: Project | null; agents: Agent[]; fleet: FleetSummary | null; onSelect: (id: string) => void }) {
  return <section className="dashboard-center">
    <div className="dashboard-hero panel-card"><div><span className="eyebrow">OPERATIONS OVERVIEW</span><h2>{project ? project.name : 'Welcome to Agent Office'}</h2><p>{project ? 'Your local worker fleet at a glance.' : 'Create a workspace to start running agents.'}</p></div><div className="live-pill"><i /> LIVE</div></div>
    <div className="dashboard-stats"><div className="panel-card"><span>Agents online</span><strong>{fleet?.agents.total ?? agents.length}</strong><small>{fleet?.agents.working ?? agents.filter(agent => agent.status === 'working').length} working now</small></div><div className="panel-card"><span>Queued tasks</span><strong>{fleet?.tasks.queued ?? 0}</strong><small>{fleet?.tasks.running ?? 0} running</small></div><div className="panel-card"><span>Approvals</span><strong>{fleet?.approvals.pending ?? 0}</strong><small>waiting for review</small></div><div className="panel-card"><span>CLI engines</span><strong>Local</strong><small>PTY sessions enabled</small></div></div>
    <div className="panel-card dashboard-office"><div className="panel-title"><h3>Live office floor</h3><span>{agents.length ? 'Click an agent to inspect' : 'No agents yet'}</span></div><OfficeFloor agents={agents} projectId={project?.id} onSelect={onSelect} /></div>
  </section>
}

type ProfileDraft = { name: string; role: string; command: string; soul: string; permissions: typeof defaultPermissions }

function AgentsCenter({ agents, profiles, active, profileDraft, editingProfileId, onSelect, onStart, onStop, onHire, onProfileDraftChange, onSaveProfile, onEditProfile, onRemoveProfile, onCancelProfile }: { agents: Agent[]; profiles: AgentProfile[]; active: Agent | null; profileDraft: ProfileDraft; editingProfileId: string | null; onSelect: (id: string) => void; onStart: (agent: Agent) => void; onStop: (agent: Agent) => void; onHire: (profile: AgentProfile) => void; onProfileDraftChange: (draft: ProfileDraft) => void; onSaveProfile: (event: React.FormEvent<HTMLFormElement>) => void; onEditProfile: (profile: AgentProfile) => void; onRemoveProfile: (profile: AgentProfile) => void; onCancelProfile: () => void }) {
  return <section className="agents-center">
    <div className="command-header"><div><h2>Agents / Fleet</h2><p>Kelola worker, profile, session, dan terminal setiap agent.</p></div><span className="task-count">{agents.length} workers</span></div>
    <div className="agent-fleet-grid">{agents.length === 0 ? <div className="panel-card empty-panel"><h3>Belum ada agent aktif</h3><p>Hire agent dari profile di bawah untuk mengisi fleet.</p></div> : agents.map(agent => <article className={`panel-card fleet-agent ${active?.id === agent.id ? 'selected' : ''}`} key={agent.id} onClick={() => onSelect(agent.id)}><div className={`fleet-avatar ${agent.status}`}><span>{agent.name.slice(0, 1).toUpperCase()}</span></div><div className="fleet-agent-copy"><strong>{agent.name}</strong><span>{agent.role}</span><small>{agent.command} · {agent.status}</small></div><div className="fleet-agent-actions">{agent.status === 'working' ? <button className="danger" onClick={event => { event.stopPropagation(); onStop(agent) }}>Stop</button> : <button className="run" onClick={event => { event.stopPropagation(); onStart(agent) }}>Start</button>}<button onClick={event => { event.stopPropagation(); onSelect(agent.id) }}>Inspect</button></div></article>)}</div>
    <div className="agent-provisioning"><div className="panel-card"><div className="panel-title"><h3>Hire from profile</h3><span>{profiles.length} available</span></div><div className="hire-grid">{profiles.map(profile => <div className="profile-card" key={profile.id}><button className="profile-hire" onClick={() => onHire(profile)}><b>{profile.name.slice(0, 1)}</b><span>{profile.name}</span><small>{profile.command}</small></button><div className="profile-actions"><button type="button" onClick={() => onEditProfile(profile)}>Edit</button>{!profile.builtIn && <button type="button" onClick={() => onRemoveProfile(profile)}>Delete</button>}</div></div>)}</div></div><div className="panel-card"><div className="panel-title"><h3>{editingProfileId ? 'Edit profile' : 'New profile'}</h3>{editingProfileId && <button className="link-button" type="button" onClick={onCancelProfile}>Cancel</button>}</div><form className="profile-form" onSubmit={onSaveProfile}><input aria-label="Profile name" placeholder="Profile name" value={profileDraft.name} onChange={event => onProfileDraftChange({ ...profileDraft, name: event.target.value })} /><input aria-label="Profile role" placeholder="Role" value={profileDraft.role} onChange={event => onProfileDraftChange({ ...profileDraft, role: event.target.value })} /><input aria-label="CLI command" placeholder="CLI command" value={profileDraft.command} onChange={event => onProfileDraftChange({ ...profileDraft, command: event.target.value })} /><textarea aria-label="SOUL instructions" placeholder="SOUL / system instructions" rows={5} value={profileDraft.soul} onChange={event => onProfileDraftChange({ ...profileDraft, soul: event.target.value })} /><div className="permission-grid">{Object.entries(profileDraft.permissions).map(([permission, enabled]) => <label key={permission}><input type="checkbox" checked={enabled} onChange={event => onProfileDraftChange({ ...profileDraft, permissions: { ...profileDraft.permissions, [permission]: event.target.checked } })} /> {permission}</label>)}</div><button className="save-profile" type="submit">{editingProfileId ? 'Save changes' : 'Create profile'}</button></form></div></div>
    {active && <div className="panel-card fleet-terminal"><div className="panel-title"><h3>{active.name} terminal</h3><span>{active.status}</span></div><TerminalPanel agent={active} /></div>}
  </section>
}

function WorkspacesCenter({ projects, activeProject, projectDraft, onDraftChange, onCreate, onSelect }: { projects: Project[]; activeProject: Project | null; projectDraft: { name: string; path: string; useWorktrees: boolean }; onDraftChange: (draft: { name: string; path: string; useWorktrees: boolean }) => void; onCreate: (event: React.FormEvent<HTMLFormElement>) => void; onSelect: (id: string) => void }) {
  return <section className="workspaces-center">
    <div className="command-header"><div><h2>Workspaces</h2><p>Project root, Git worktree, dan konteks agent.</p></div><span className="task-count">{projects.length} projects</span></div>
    <div className="workspace-manager-grid"><form className="panel-card project-form" onSubmit={onCreate}><h3>Add workspace</h3><input aria-label="Workspace name" placeholder="Project name (optional)" value={projectDraft.name} onChange={event => onDraftChange({ ...projectDraft, name: event.target.value })} /><input aria-label="Workspace path" placeholder="Absolute folder path" value={projectDraft.path} onChange={event => onDraftChange({ ...projectDraft, path: event.target.value })} /><label className="checkbox-row"><input type="checkbox" checked={projectDraft.useWorktrees} onChange={event => onDraftChange({ ...projectDraft, useWorktrees: event.target.checked })} /> One Git worktree per agent</label><button className="save-profile" type="submit">Add workspace</button></form><div className="panel-card workspace-list-panel"><h3>Available workspaces</h3><div className="workspace-list">{projects.length === 0 ? <p className="muted">No workspace configured.</p> : projects.map(project => <button className={`workspace-row ${activeProject?.id === project.id ? 'active' : ''}`} key={project.id} onClick={() => onSelect(project.id)}><span><strong>{project.name}</strong><small>{project.path}</small></span><em>{activeProject?.id === project.id ? 'Active' : project.useWorktrees ? 'Worktrees' : 'Shared folder'}</em></button>)}</div></div></div>
  </section>
}

function InboxCenter({ project, agents }: { project: Project | null; agents: Agent[] }) {
  const [messages, setMessages] = useState<Message[]>([])
  const [events, setEvents] = useState<ActivityEvent[]>([])
  const [fromAgent, setFromAgent] = useState('')
  const [toAgent, setToAgent] = useState('')
  const [body, setBody] = useState('')
  const refresh = () => project ? Promise.all([window.office.listMessages(project.id), window.office.listEvents(project.id)]).then(([nextMessages, nextEvents]) => { setMessages(nextMessages); setEvents(nextEvents) }) : Promise.resolve()
  useEffect(() => { refresh() }, [project?.id])
  async function send(event: React.FormEvent<HTMLFormElement>) { event.preventDefault(); if (!project || !fromAgent || !toAgent || !body.trim()) return; await window.office.sendMessage({ projectId: project.id, fromAgent, toAgent, body }); setBody(''); await refresh() }
  return <section className="inbox-center"><div className="command-header"><div><h2>Inbox / Activity</h2><p>{project ? `Mailbox dan event log untuk ${project.name}.` : 'Select a workspace first.'}</p></div><span className="task-count">{messages.length} messages</span></div><div className="coordination-grid"><div className="panel-card"><div className="panel-title"><h3>Send message</h3><span>Durable mailbox</span></div><form className="message-form" onSubmit={send}><select aria-label="Message sender" value={fromAgent} onChange={event => setFromAgent(event.target.value)}><option value="">From agent</option>{agents.map(agent => <option key={agent.id} value={agent.id}>{agent.name}</option>)}</select><select aria-label="Message recipient" value={toAgent} onChange={event => setToAgent(event.target.value)}><option value="">To agent</option>{agents.filter(agent => agent.id !== fromAgent).map(agent => <option key={agent.id} value={agent.id}>{agent.name}</option>)}</select><textarea aria-label="Message body" placeholder="Write a message to another agent" rows={4} value={body} onChange={event => setBody(event.target.value)} /><button className="save-profile" type="submit">Send message</button></form><div className="message-list">{messages.slice(0, 20).map(message => <div className="message-row" key={message.id}><strong>{message.fromName ?? message.fromAgent} → {message.toName ?? message.toAgent}</strong><p>{message.body}</p><small>{new Date(message.createdAt).toLocaleString()}</small></div>)}</div></div><div className="panel-card"><div className="panel-title"><h3>Activity log</h3><span>{events.length} events</span></div><div className="event-list">{events.slice(0, 30).map(event => <div className="event-row" key={event.id}><code>{event.type}</code><span>{new Date(event.createdAt).toLocaleTimeString()}</span></div>)}</div></div></div></section>
}

function GithubCenter({ project }: { project: Project | null }) {
  const [status, setStatus] = useState<{ installed: boolean; authenticated: boolean }>({ installed: false, authenticated: false })
  const [message, setMessage] = useState('')
  useEffect(() => { if (project) window.office.githubStatus(project.id).then(setStatus) }, [project?.id])
  async function syncIssues() { if (!project || !status.authenticated) return; const imported = await window.office.importGithubIssues(project.id); setMessage(`${imported.length} open issue(s) synchronized as tasks.`) }
  return <section className="github-center"><div className="command-header"><div><h2>GitHub</h2><p>Hubungkan issue repository ke task lokal dengan approval gate.</p></div><span className={`github-status ${status.authenticated ? 'ready' : ''}`}>{status.authenticated ? 'Authenticated' : status.installed ? 'Login required' : 'gh missing'}</span></div><div className="github-overview-grid"><div className="panel-card"><h3>Connection</h3><div className="integration-state"><span className={status.installed ? 'state-ok' : 'state-muted'}>{status.installed ? '●' : '○'} GitHub CLI installed</span><span className={status.authenticated ? 'state-ok' : 'state-muted'}>{status.authenticated ? '●' : '○'} Account authenticated</span></div><button className="save-profile" type="button" onClick={syncIssues} disabled={!project || !status.authenticated}>Sync open issues</button>{message && <small className="muted">{message}</small>}</div><div className="panel-card"><h3>Safety rules</h3><p className="muted">Issue import membuat task durable. Push dan pembuatan pull request tetap membutuhkan approval manusia.</p><div className="github-flow"><span>Issue</span><b>→</b><span>Task</span><b>→</b><span>Agent</span><b>→</b><span>Review</span></div></div></div></section>
}

function App() {
  const [agents, setAgents] = useState<Agent[]>([])
  const [profiles, setProfiles] = useState<AgentProfile[]>([])
  const [projects, setProjects] = useState<Project[]>([])
  const [activeProject, setActiveProject] = useState<Project | null>(null)
  const [fleet, setFleet] = useState<FleetSummary | null>(null)
  const [activeId, setActiveId] = useState<string | null>(null)
  const [clis, setClis] = useState<CliInfo[]>([])
  const [profileDraft, setProfileDraft] = useState(emptyProfile)
  const [projectDraft, setProjectDraft] = useState({ name: '', path: '', useWorktrees: true })
  const [editingProfileId, setEditingProfileId] = useState<string | null>(null)
  const [commitMessage, setCommitMessage] = useState('')
  const [commitLocked, setCommitLocked] = useState(false)
  const [view, setView] = useState<AppView>('dashboard')

  const refresh = async () => {
    const [nextAgents, nextProfiles, nextProjects, nextActiveProject] = await Promise.all([
      window.office.listAgents(),
      window.office.listProfiles(),
      window.office.listProjects(),
      window.office.activeProject()
    ])
    setAgents(nextAgents)
    setProfiles(nextProfiles)
    setProjects(nextProjects)
    setActiveProject(nextActiveProject)
    setFleet(await window.office.fleetSummary(nextActiveProject?.id))
  }

  useEffect(() => {
    refresh()
    window.office.detectCli().then(setClis)
    const offExit = window.office.onAgentExit(() => refresh())
    const offState = window.office.onAgentState(() => refresh())
    return () => { offExit(); offState() }
  }, [])

  async function addAgent(profile: AgentProfile) {
    const agent = await window.office.createAgent({
      id: crypto.randomUUID(),
      name: profile.name,
      role: profile.role,
      command: profile.command,
      cwd: '.',
      profileId: profile.id,
      projectId: activeProject?.id ?? null,
    })
    setAgents(value => [...value, agent])
    setActiveId(agent.id)
  }

  async function selectProject(id: string) {
    await window.office.setActiveProject(id)
    setActiveId(null)
    await refresh()
  }

  async function createProject(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!projectDraft.path.trim()) return
    const project = await window.office.createProject({ id: crypto.randomUUID(), ...projectDraft })
    await window.office.setActiveProject(project.id)
    setProjectDraft({ name: '', path: '', useWorktrees: true })
    setActiveId(null)
    await refresh()
  }

  async function saveProfile(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!profileDraft.name.trim() || !profileDraft.role.trim() || !profileDraft.command.trim()) return
    const profile = { ...profileDraft, id: editingProfileId ?? crypto.randomUUID() }
    if (editingProfileId) await window.office.updateProfile(profile)
    else await window.office.createProfile(profile)
    setProfileDraft(emptyProfile)
    setEditingProfileId(null)
    await refresh()
  }

  function editProfile(profile: AgentProfile) {
    setEditingProfileId(profile.id)
    setProfileDraft({ name: profile.name, role: profile.role, command: profile.command, soul: profile.soul, permissions: { ...defaultPermissions, ...profile.permissions } })
  }

  async function removeProfile(profile: AgentProfile) {
    if (profile.builtIn || !window.confirm(`Delete profile ${profile.name}?`)) return
    await window.office.removeProfile(profile.id)
    if (editingProfileId === profile.id) {
      setEditingProfileId(null)
      setProfileDraft(emptyProfile)
    }
    await refresh()
  }

  async function start(agent: Agent) {
    setActiveId(agent.id)
    await window.office.startAgent(agent)
    refresh()
  }

  async function stop(agent: Agent) {
    await window.office.stopAgent(agent.id)
    await refresh()
  }

  async function acquireCommitLock(agent: Agent) {
    if (!agent.projectId) return
    await window.office.acquireCommitLock({ projectId: agent.projectId, agentId: agent.id })
    setCommitLocked(true)
  }

  async function commitAgent(agent: Agent) {
    if (!commitMessage.trim()) return
    await window.office.commit({ agentId: agent.id, message: commitMessage })
    setCommitMessage('')
    setCommitLocked(false)
    await refresh()
  }

  const active = agents.find(agent => agent.id === activeId) ?? null
  const activeProfile = active?.profileId ? profiles.find(profile => profile.id === active.profileId) : null
  const pageMeta: Record<AppView, { title: string; description: string }> = {
    dashboard: { title: 'Dashboard', description: 'Pantau seluruh operasi office dalam satu layar.' },
    floor: { title: 'Office Floor', description: 'Run coding agents as local terminal workers.' },
    agents: { title: 'Agents / Fleet', description: 'Kelola worker, session, dan terminal setiap agent.' },
    workspaces: { title: 'Workspaces', description: 'Kelola project root dan Git worktree.' },
    command: { title: 'Tasks & Missions', description: 'Plan, assign, and track work across your agents.' },
    inbox: { title: 'Inbox / Activity', description: 'Mailbox durable dan jejak aktivitas seluruh worker.' },
    github: { title: 'GitHub', description: 'Sinkronkan issue dan kelola workflow pull request.' },
    memory: { title: 'Shared Memory', description: 'Capture durable project knowledge in Markdown.' },
    settings: { title: 'Settings & Safety', description: 'Preview, approve, and safely apply local configuration changes.' },
  }

  return <div className="app-shell">
    <aside className="sidebar">
      <div className="brand"><img className="brand-logo" src={logoLandscapeUrl} alt="Agent Office" /></div>
      <nav>
        <button className={`nav ${view === 'dashboard' ? 'active' : ''}`} onClick={() => setView('dashboard')}>Dashboard</button>
        <button className={`nav ${view === 'floor' ? 'active' : ''}`} onClick={() => setView('floor')}>Office Floor</button>
        <button className={`nav ${view === 'agents' ? 'active' : ''}`} onClick={() => setView('agents')}>Agents / Fleet</button>
        <button className={`nav ${view === 'workspaces' ? 'active' : ''}`} onClick={() => setView('workspaces')}>Workspaces</button>
        <button className={`nav ${view === 'command' ? 'active' : ''}`} onClick={() => setView('command')}>Tasks & Missions</button>
        <button className={`nav ${view === 'inbox' ? 'active' : ''}`} onClick={() => setView('inbox')}>Inbox / Activity</button>
        <button className={`nav ${view === 'github' ? 'active' : ''}`} onClick={() => setView('github')}>GitHub</button>
        <button className={`nav ${view === 'memory' ? 'active' : ''}`} onClick={() => setView('memory')}>Memory</button>
        <button className={`nav ${view === 'settings' ? 'active' : ''}`} onClick={() => setView('settings')}>Settings & Safety</button>
      </nav>
      <div className="cli-box">
        <h4>CLI engines</h4>
        {clis.map(cli => <div className="cli-row" key={cli.command}><span>{cli.command}</span><i className={cli.installed ? 'ok' : 'no'}>{cli.installed ? 'ready' : 'missing'}</i></div>)}
      </div>
    </aside>

    <main>
      <header className="topbar">
        <div><h1>{pageMeta[view].title}</h1><p>{pageMeta[view].description}</p></div>
        <div className="workspace-switcher"><label htmlFor="project-select">Workspace</label><select id="project-select" value={activeProject?.id ?? ''} onChange={event => selectProject(event.target.value)}>{projects.map(project => <option key={project.id} value={project.id}>{project.name}</option>)}</select><code title={activeProject?.path}>{activeProject?.path ?? 'No workspace selected'}</code></div>
        <div className="stats"><span><b>{fleet?.agents.total ?? agents.length}</b> agents</span><span><b>{fleet?.agents.working ?? agents.filter(agent => agent.status === 'working').length}</b> working</span><span><b>{fleet?.tasks.queued ?? 0}</b> queued</span><span><b>{fleet?.approvals.pending ?? 0}</b> approvals</span></div>
      </header>

      {view === 'dashboard' ? <DashboardCenter project={activeProject} agents={agents} fleet={fleet} onSelect={id => { setActiveId(id); setCommitLocked(false) }} /> : view === 'agents' ? <AgentsCenter agents={agents} profiles={profiles} active={active} profileDraft={profileDraft} editingProfileId={editingProfileId} onSelect={id => { setActiveId(id); setCommitLocked(false) }} onStart={start} onStop={stop} onHire={addAgent} onProfileDraftChange={setProfileDraft} onSaveProfile={saveProfile} onEditProfile={editProfile} onRemoveProfile={removeProfile} onCancelProfile={() => { setEditingProfileId(null); setProfileDraft(emptyProfile) }} /> : view === 'workspaces' ? <WorkspacesCenter projects={projects} activeProject={activeProject} projectDraft={projectDraft} onDraftChange={setProjectDraft} onCreate={createProject} onSelect={selectProject} /> : view === 'inbox' ? <InboxCenter project={activeProject} agents={agents} /> : view === 'github' ? <GithubCenter project={activeProject} /> : view === 'command' ? <CommandCenter project={activeProject} agents={agents} /> : view === 'memory' ? <MemoryCenter project={activeProject} agents={agents} /> : view === 'settings' ? <SettingsCenter project={activeProject} /> : <><section className="workspace">
        <div className="floor-card">
          {agents.length === 0 ? <div className="floor-grid"><div className="empty-state"><h2>Your office is empty</h2><p>Add an agent from a profile to create the first worker.</p></div></div> : <OfficeFloor agents={agents} projectId={activeProject?.id} onSelect={id => { setActiveId(id); setCommitLocked(false) }} />}
          {/* CSS floor remains the empty state so the app stays useful before the first agent is hired. */}
          {/*
            {agents.length === 0 && <div className="empty-state"><h2>Your office is empty</h2><p>Add an agent from a profile to create the first worker.</p></div>}
            {agents.map((agent, index) => <button key={agent.id} className={`desk desk-${index % 6}`} onClick={() => setActiveId(agent.id)}>
              <div className={`avatar ${agent.status}`}><span>{agent.name.slice(0, 1)}</span></div>
              <div className="desk-object">▰</div>
              <strong>{agent.name}</strong><small>{agent.role}</small><em>{agent.status}{agent.dirty ? ' · changes' : ''}</em>
            </button>)}
          */}
        </div>

        <div className="right-panel">
          <div className="panel-card">
            <h3>Selected Agent</h3>
            {active ? <div className="selected-agent">
              <div><strong>{active.name}</strong><span>{active.role}</span><code>{active.command}</code><small className="workspace-path" title={active.worktreePath || active.cwd}>{active.branch ? `${active.projectName ?? 'Project'} · ${active.branch}` : active.projectName ?? active.cwd}</small></div>
              {activeProfile && <details className="soul-preview"><summary>{activeProfile.name} · SOUL instructions</summary><pre>{activeProfile.soul || 'No instructions configured.'}</pre></details>}
              {active.worktreePath && <div className="commit-controls"><button onClick={() => acquireCommitLock(active)}>{commitLocked ? 'Commit lock acquired' : 'Acquire commit lock'}</button><input aria-label="Commit message" placeholder="Commit message" value={commitMessage} onChange={event => setCommitMessage(event.target.value)} /><button onClick={() => commitAgent(active)} disabled={!commitLocked || !commitMessage.trim()}>Commit tracked changes</button></div>}
              {active.status === 'working' ? <button className="danger" onClick={async () => { await window.office.stopAgent(active.id); await refresh() }}>Stop session</button> : <button className="run" onClick={() => start(active)}>Start session</button>}
              <button className="danger" onClick={async () => { await window.office.removeAgent(active.id); setActiveId(null); refresh() }}>Remove</button>
            </div> : <p className="muted">Select a desk on the floor.</p>}
          </div>
        </div>
      </section>

      <section className="terminal-card">
        <div className="terminal-head"><span>Terminal</span><code>{active ? `${active.name} · ${active.command}` : 'No active agent'}</code></div>
        <TerminalPanel agent={active} />
      </section>
      </>}
    </main>
  </div>
}

createRoot(document.getElementById('root')!).render(<App />)
