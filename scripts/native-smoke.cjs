const { spawnSync } = require('node:child_process')
const electron = require('electron')

const code = `
  const pty = require('node-pty')
  const Database = require('better-sqlite3')
  const db = new Database(':memory:')
  if (db.prepare('SELECT 1 AS ok').get().ok !== 1) process.exit(2)
  const term = pty.spawn(process.platform === 'win32' ? 'cmd.exe' : '/bin/sh', process.platform === 'win32' ? ['/c', 'echo native-smoke'] : ['-lc', 'printf native-smoke'], { name: 'xterm', cols: 80, rows: 24 })
  let output = ''
  term.onData(data => { output += data })
  term.onExit(() => { if (!output.includes('native-smoke')) process.exit(3); console.log('native modules: ok') })
`

const result = spawnSync(electron, ['-e', code], {
  env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  encoding: 'utf8',
  stdio: 'inherit'
})

process.exit(result.status ?? 1)
