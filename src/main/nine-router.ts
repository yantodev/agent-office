import { providerAdapter } from './provider-adapters'

export const DEFAULT_NINEROUTER_BASE_URL = 'http://127.0.0.1:20128/v1'

export type NineRouterConfig = {
  enabled: boolean
  baseUrl: string
  apiKey?: string
  model?: string
}

export type NineRouterHealthStatus = 'disabled' | 'healthy' | 'unauthorized' | 'rate-limited' | 'invalid' | 'unreachable' | 'error'

export type NineRouterHealth = {
  enabled: boolean
  status: NineRouterHealthStatus
  reachable: boolean
  configured: boolean
  apiKeyConfigured: boolean
  baseUrl: string
  model?: string
  latencyMs: number | null
  checkedAt: string
  error?: string
}

function normalizeBaseUrl(value: string) {
  const url = new URL(value)
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('9router endpoint must use HTTP or HTTPS')
  if (url.username || url.password) throw new Error('9router endpoint must not contain credentials')
  return url.toString().replace(/\/$/, '')
}

function safeHealthError(error: unknown) {
  const message = error instanceof Error ? error.message : 'Unable to reach 9router'
  return message.slice(0, 240)
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

/**
 * Memeriksa endpoint OpenAI-compatible 9router tanpa mengembalikan API key.
 * Request bisa diinjeksi agar health check dapat diuji tanpa service eksternal.
 */
export async function checkNineRouter(
  environment: Record<string, string | undefined>,
  request: (input: string, init?: RequestInit) => Promise<Response> = fetch,
  timeoutMs = 4_000,
): Promise<NineRouterHealth> {
  const config = readNineRouterConfig(environment)
  const checkedAt = new Date().toISOString()
  const base = {
    enabled: config.enabled,
    configured: Boolean(config.apiKey),
    apiKeyConfigured: Boolean(config.apiKey),
    baseUrl: config.baseUrl,
    model: config.model,
    latencyMs: null,
    checkedAt,
  }
  if (!config.enabled) return { ...base, status: 'disabled', reachable: false }

  try {
    normalizeBaseUrl(config.baseUrl)
  } catch (error) {
    return { ...base, status: 'invalid', reachable: false, error: safeHealthError(error) }
  }

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)
  const startedAt = Date.now()
  try {
    const headers: Record<string, string> = { accept: 'application/json' }
    if (config.apiKey) headers.authorization = `Bearer ${config.apiKey}`
    const response = await request(`${config.baseUrl}/models`, { method: 'GET', headers, signal: controller.signal })
    const latencyMs = Date.now() - startedAt
    if (response.status === 401 || response.status === 403) return { ...base, status: 'unauthorized', reachable: true, latencyMs, error: '9router rejected the API key' }
    if (response.status === 429) return { ...base, status: 'rate-limited', reachable: true, latencyMs, error: '9router rate limit exceeded' }
    if (response.ok) return { ...base, status: 'healthy', reachable: true, latencyMs }
    return { ...base, status: 'error', reachable: true, latencyMs, error: `9router returned HTTP ${response.status}` }
  } catch (error) {
    const message = error instanceof Error && error.name === 'AbortError' ? '9router health check timed out' : safeHealthError(error)
    return { ...base, status: 'unreachable', reachable: false, latencyMs: Date.now() - startedAt, error: message }
  } finally {
    clearTimeout(timeout)
  }
}
