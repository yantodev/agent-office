import path from 'node:path'

export type ProviderId = 'codex' | 'opencode' | 'claude' | 'gemini' | 'qwen' | 'copilot' | 'generic'

export type ProviderAdapter = {
  id: ProviderId
  contextPrefix: string
  submitPrompt: (prompt: string) => string
  interrupt: string
  supportsSteer: boolean
  injectContext: (environment: Record<string, string>, soul: string, taskPrompt: string) => Record<string, string>
}

const providerAliases: Record<ProviderId, string[]> = {
  codex: ['codex'],
  opencode: ['opencode'],
  claude: ['claude'],
  gemini: ['gemini'],
  qwen: ['qwen'],
  copilot: ['copilot', 'github-copilot'],
  generic: [],
}

function providerId(command: string): ProviderId {
  const executable = path.basename(command.trim().split(/\s+/, 1)[0] ?? '').toLowerCase().replace(/\.exe$/, '')
  return (Object.entries(providerAliases).find(([, aliases]) => aliases.includes(executable))?.[0] ?? 'generic') as ProviderId
}

function createAdapter(id: ProviderId): ProviderAdapter {
  const contextPrefix = id === 'generic' ? 'AGENT_OFFICE' : `AGENT_OFFICE_${id.toUpperCase()}`
  return {
    id,
    contextPrefix,
    submitPrompt: prompt => `${prompt}\r`,
    interrupt: '\u0003',
    supportsSteer: true,
    injectContext: (environment, soul, taskPrompt) => ({
      ...environment,
      AGENT_OFFICE_PROVIDER: id,
      [`${contextPrefix}_SOUL`]: soul,
      [`${contextPrefix}_TASK_PROMPT`]: taskPrompt,
    }),
  }
}

export function providerAdapter(command: string) {
  return createAdapter(providerId(command))
}
