import { spawn } from 'node:child_process'
import { join } from 'node:path'

if (!process.env.AGENT_OFFICE_WEB_TOKEN) {
  console.error('AGENT_OFFICE_WEB_TOKEN belum tersedia. Salin .env.example menjadi .env dan isi tokennya.')
  process.exit(1)
}

const root = process.cwd()
const windows = process.platform === 'win32'
const viteBin = join(root, 'node_modules', '.bin', windows ? 'vite.cmd' : 'vite')
const options = { cwd: root, env: process.env, stdio: 'inherit', shell: windows }
const children = [
  spawn(process.execPath, ['--experimental-strip-types', 'src/web/main.ts'], options),
  spawn(viteBin, ['--config', 'vite.config.web.ts'], options),
]
let shuttingDown = false

function shutdown(code) {
  if (shuttingDown) return
  shuttingDown = true
  for (const child of children) {
    if (child.exitCode === null) child.kill('SIGTERM')
  }
  process.exitCode = code
}

for (const child of children) {
  child.on('error', error => {
    console.error(`Gagal menjalankan web process: ${error.message}`)
    shutdown(1)
  })
  child.on('exit', (code, signal) => {
    if (!shuttingDown) {
      console.error(`Web process berhenti${signal ? ` karena ${signal}` : ` dengan kode ${code ?? 1}`}.`)
      shutdown(code ?? 1)
    }
  })
}

process.on('SIGINT', () => shutdown(0))
process.on('SIGTERM', () => shutdown(0))
