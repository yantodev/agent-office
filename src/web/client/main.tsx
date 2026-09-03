import { useState, type FormEvent } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from '../../renderer/src/main'
import { createWebOfficeApi } from './api'

import '../../renderer/src/styles/app.css'

const root = createRoot(document.getElementById('root')!)
const tokenKey = 'agent-office.web.token'
const baseUrl = window.location.origin

function Login({ onLogin }: { onLogin: (token: string) => Promise<void> }) {
  const [token, setToken] = useState(localStorage.getItem(tokenKey) ?? '')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!token.trim()) return
    setLoading(true)
    setError('')
    try {
      await onLogin(token.trim())
      localStorage.setItem(tokenKey, token.trim())
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Token tidak valid atau server tidak tersedia.')
    } finally {
      setLoading(false)
    }
  }

  return <main className="web-auth-shell">
    <section className="web-auth-card panel-card">
      <div className="web-brand-mark">AO</div>
      <span className="eyebrow">SECURE WEB GATEWAY</span>
      <h1>Agent Office</h1>
      <p className="muted">Masukkan token web server untuk membuka office dari browser.</p>
      <form className="profile-form" onSubmit={submit}>
        <label htmlFor="web-token">Access token</label>
        <input id="web-token" type="password" autoComplete="current-password" placeholder="AGENT_OFFICE_WEB_TOKEN" value={token} onChange={event => setToken(event.target.value)} required />
        <button className="save-profile" type="submit" disabled={loading}>{loading ? 'Connecting…' : 'Open office'}</button>
      </form>
      {error && <p className="renderer-feedback" role="alert">{error}</p>}
      <small className="muted">Token hanya disimpan di localStorage browser ini dan dikirim melalui Bearer authentication.</small>
    </section>
  </main>
}

async function login(token: string) {
  const api = createWebOfficeApi(baseUrl, token)
  try {
    await api.listProjects()
  } catch (error) {
    if (error instanceof Error && error.message.includes('Unauthorized')) localStorage.removeItem(tokenKey)
    throw error
  }
  window.office = api
  root.render(<App />)
}

const savedToken = localStorage.getItem(tokenKey)
if (savedToken) void login(savedToken).catch(() => root.render(<Login onLogin={login} />))
else root.render(<Login onLogin={login} />)
