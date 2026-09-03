import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

const { assertTaskTransition, isTaskStatus, resolveTaskReadiness } = await import('../src/main/task-lifecycle.ts')
const { executionPlan } = await import('../src/main/permission-policy.ts')
const { providerAdapter } = await import('../src/main/provider-adapters.ts')
const { canonicalPath, isCanonicalPathInside, redactSecrets } = await import('../src/main/security.ts')
const { writeJsonAtomic } = await import('../src/main/persistence.ts')
const { summarizeExecutionUsage } = await import('../src/main/telemetry.ts')
const { appendTerminalBuffer, clearTerminalBuffer, getTerminalBuffer, hasTerminalBuffer, subscribeTerminalBuffer } = await import('../src/renderer/src/terminal-buffer.ts')

test('task lifecycle rejects invalid transitions and resolves readiness', () => {
  assert.equal(isTaskStatus('review'), true)
  assert.equal(isTaskStatus('unknown'), false)
  assert.doesNotThrow(() => assertTaskTransition('assigned', 'running'))
  assert.throws(() => assertTaskTransition('done', 'running'), /Invalid task transition/)
  assert.deepEqual(resolveTaskReadiness('agent-1', false, false), { status: 'blocked', blockedReason: 'dependencies' })
  assert.deepEqual(resolveTaskReadiness(null, true, false), { status: 'backlog', blockedReason: null })
})

test('secret redaction removes token formats and key-value secrets', () => {
  const result = redactSecrets('token=supersecret ghp_12345678901234567890 password: hunter2')
  assert.equal(result.includes('supersecret'), false)
  assert.equal(result.includes('hunter2'), false)
  assert.equal(result.includes('12345678901234567890'), false)
  assert.match(result, /\[REDACTED/) 
})

test('canonical path checks block traversal and symlink escape', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-office-security-'))
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-office-outside-'))
  fs.mkdirSync(path.join(root, 'nested'))
  assert.equal(isCanonicalPathInside(root, path.join(root, 'nested', 'new.txt')), true)
  assert.equal(isCanonicalPathInside(root, path.join(root, '..', path.basename(outside), 'secret.txt')), false)
  try {
    fs.symlinkSync(outside, path.join(root, 'escape'), 'junction')
  } catch {
    t.skip('symlink creation is unavailable on this runner')
    return
  }
  assert.equal(canonicalPath(path.join(root, 'escape')), outside)
  assert.equal(isCanonicalPathInside(root, path.join(root, 'escape', 'secret.txt')), false)
})

test('execution plan runs unrestricted profiles directly and fails closed when restricted sandbox is unavailable', () => {
  const environment = { PATH: process.env.PATH || '' }
  const shell = { shell: process.platform === 'win32' ? 'powershell.exe' : '/bin/sh', args: ['-lc', 'printf smoke'] }
  const direct = executionPlan({ platform: process.platform, permissions: { filesystem: true, network: true, git: true }, cwd: process.cwd(), userDataPath: os.tmpdir(), shell, environment })
  assert.equal(direct.sandboxed, false)
  if (process.platform !== 'linux') {
    assert.throws(() => executionPlan({ platform: process.platform, permissions: { filesystem: false, network: false, git: false }, cwd: process.cwd(), userDataPath: os.tmpdir(), shell, environment }), /sandbox/)
  }
})

test('provider adapters isolate context and terminal controls per CLI', () => {
  const adapter = providerAdapter('codex --profile developer')
  const context = adapter.injectContext({ PATH: '/bin' }, 'soul', 'task')
  assert.equal(adapter.id, 'codex')
  assert.equal(context.AGENT_OFFICE_PROVIDER, 'codex')
  assert.equal(context.AGENT_OFFICE_CODEX_SOUL, 'soul')
  assert.equal(context.AGENT_OFFICE_CODEX_TASK_PROMPT, 'task')
  assert.equal(adapter.submitPrompt('hello'), 'hello\r')
  assert.equal(adapter.interrupt, '\u0003')
  assert.equal(providerAdapter('github-copilot.exe').id, 'copilot')
})

test('atomic persistence leaves valid JSON after concurrent writes', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-office-persistence-'))
  const target = path.join(directory, 'message.json')
  await Promise.all(Array.from({ length: 32 }, (_, index) => Promise.resolve().then(() => writeJsonAtomic(target, { id: index, body: `message-${index}` }))))
  const value = JSON.parse(fs.readFileSync(target, 'utf8'))
  assert.equal(typeof value.id, 'number')
  assert.equal(fs.readdirSync(directory).some(file => file.endsWith('.tmp')), false)
})

test('telemetry aggregation only reports local execution usage', () => {
  assert.deepEqual(summarizeExecutionUsage([{ durationMs: 120, outputBytes: 10 }, { durationMs: null, outputBytes: 5 }]), { durationMs: 120, outputBytes: 15 })
})

test('terminal buffer survives panel unmount and clears when the session exits', () => {
  const id = 'terminal-buffer-smoke'
  clearTerminalBuffer(id)
  const unsubscribe = subscribeTerminalBuffer(() => undefined)
  appendTerminalBuffer(id, 'first output')
  unsubscribe()
  appendTerminalBuffer(id, ' while navigating')
  assert.equal(hasTerminalBuffer(id), true)
  assert.match(getTerminalBuffer(id), /first output while navigating/)
  clearTerminalBuffer(id)
  assert.equal(hasTerminalBuffer(id), false)
  assert.equal(getTerminalBuffer(id), '')
})
