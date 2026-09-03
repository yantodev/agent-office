import React, { useEffect, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import { getTerminalBuffer, hasTerminalBuffer, subscribeTerminalBuffer } from '../terminal-buffer'

export function TerminalPanel({ agent }: { agent: Agent | null }) {
  const host = useRef<HTMLDivElement>(null)
  const terminal = useRef<Terminal | null>(null)
  const fit = useRef<FitAddon | null>(null)
  const activeId = useRef<string | null>(null)
  const [steer, setSteer] = useState('')

  useEffect(() => {
    if (!host.current) return
    const t = new Terminal({ convertEol: true, cursorBlink: true, fontSize: 13, theme: { background: '#07101f' } })
    const f = new FitAddon()
    t.loadAddon(f)
    t.open(host.current)
    f.fit()
    terminal.current = t
    fit.current = f
    t.writeln('\x1b[36mAgent Office terminal ready.\x1b[0m')
    t.onData(data => activeId.current && window.office.writeTerminal(activeId.current, data))
    const onResize = () => { f.fit(); if(activeId.current) window.office.resizeTerminal(activeId.current, t.cols, t.rows) }
    window.addEventListener('resize', onResize)
    const offBuffer = subscribeTerminalBuffer(update => {
      if (update.id !== activeId.current || !terminal.current) return
      if (update.cleared) {
        terminal.current.clear()
        terminal.current.writeln('\x1b[90mTerminal session ended. Start a new session to continue.\x1b[0m')
      } else if (update.data) {
        terminal.current.write(update.data)
      }
    })
    return () => { offBuffer(); window.removeEventListener('resize', onResize); t.dispose() }
  }, [])

  useEffect(() => {
    activeId.current = agent?.id ?? null
    if (terminal.current) {
      terminal.current.clear()
      if (!agent) terminal.current.writeln('\x1b[90mSelect an agent to attach.\x1b[0m')
      else if (hasTerminalBuffer(agent.id)) terminal.current.write(getTerminalBuffer(agent.id))
      else terminal.current.writeln(`\x1b[32mSelected ${agent.name}. Click Start session.\x1b[0m`)
      setTimeout(() => fit.current?.fit(), 50)
    }
  }, [agent?.id])

  async function control(action: 'pause' | 'resume' | 'interrupt' | 'steer' | 'constrain') {
    if (!agent) return
    await window.office.controlAgent({ id: agent.id, action, text: action === 'steer' ? steer : undefined })
    if (action === 'steer') setSteer('')
  }

  return <>
    <div className="terminal-host" ref={host}/>
    <div className="terminal-controls">
      <input aria-label="Steer agent" placeholder="Send prompt to active agent" value={steer} onChange={event => setSteer(event.target.value)} onKeyDown={event => { if (event.key === 'Enter') control('steer') }} disabled={!agent} />
      <button onClick={() => control('steer')} disabled={!agent || !steer.trim()}>Send</button>
      <button onClick={() => control('constrain')} disabled={!agent}>Constrain</button>
      <button onClick={() => control('interrupt')} disabled={!agent}>Interrupt</button>
      {agent?.status === 'paused' ? <button onClick={() => control('resume')}>Resume</button> : <button onClick={() => control('pause')} disabled={!agent || agent.status !== 'working'}>Pause</button>}
    </div>
  </>
}
