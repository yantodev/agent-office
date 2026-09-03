import { providerAdapter } from './provider-adapters'

export const DEFAULT_NINEROUTER_BASE_URL = 'http://127.0.0.1:20128/v1'

export type NineRouterConfig = {
  enabled: boolean
  baseUrl: string
  apiKey?: string
  model?: string
}

function normalizeBaseUrl(value: string) {
  const url = new URL(value)
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('9router endpoint must use HTTP or HTTPS')
  if (url.username || url.password) throw new Error('9router endpoint must not contain credentials')
  return url.toString().replace(/\/$/, '')
}

export function readNineRouterConfig(environment: Record<string, string | undefined>): NineRouterConfig {
  const rawBaseUrl = environment.AGENT_OFFICE_9ROUTER_BASE_URL?.trim() || DEFAULT_NINEROUTER_BASE_URL
  let baseUrl = rawBaseUrl
  try { baseUrl = normalizeBaseUrl(rawBaseUrl) } catch { /* health check akan melaporkan endpoint invalid */ }
  return {
    enabled: environment.AGENT_OFFICE_9ROUTER_ENABLED === '1',
    baseUrl,
    apiKey: environment.AGENT_OFFICE_9ROUTER_API_KEY?.trim() || undefined,
    model: environment.AGENT_OFFICE_9ROUTER_MODEL?.trim() || undefined,
  }
}

/**
 * Menambahkan environment gateway hanya ketika 9router diaktifkan.
 * API key tidak pernah dibuat ulang; jika permission secrets menghapusnya,
 * key juga tidak akan masuk ke child process.
 */
export function injectNineRouterEnvironment(command: string, environment: Record<string, string>) {
  const config = readNineRouterConfig(environment)
  if (!config.enabled) return environment

  const provider = providerAdapter(command).id
  const prefix = provider === 'claude' ? 'ANTHROPIC' : 'OPENAI'
  const injected = {
    ...environment,
    AGENT_OFFICE_9ROUTER_ENABLED: '1',
    AGENT_OFFICE_9ROUTER_BASE_URL: config.baseUrl,
    [`${prefix}_BASE_URL`]: config.baseUrl,
  }
  if (config.apiKey) {
    injected[`${prefix}_API_KEY`] = config.apiKey
    if (prefix === 'ANTHROPIC') injected.ANTHROPIC_AUTH_TOKEN = config.apiKey
  }
  if (config.model) {
    injected.AGENT_OFFICE_9ROUTER_MODEL = config.model
    injected[`${prefix}_MODEL`] = config.model
  }
  return injected
}
