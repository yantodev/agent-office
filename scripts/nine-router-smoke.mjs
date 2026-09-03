import assert from 'node:assert/strict'
import { checkNineRouter } from '../src/main/nine-router.ts'

const health = await checkNineRouter(process.env)
if (health.status === 'disabled') {
  console.log('9router smoke skipped: AGENT_OFFICE_9ROUTER_ENABLED is not 1')
} else {
  assert.equal(health.status, 'healthy', health.error || `9router status: ${health.status}`)
  assert.equal(health.reachable, true)
  assert.equal('apiKey' in health, false)
  console.log(`9router integration: ok (${health.latencyMs ?? 0} ms)`)
}
