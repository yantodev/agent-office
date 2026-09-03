import { createRequire } from 'node:module'
import { spawnSync } from 'node:child_process'

const require = createRequire(import.meta.url)

function nativeModulesLoad() {
  let database
  try {
    const Database = require('better-sqlite3')
    database = new Database(':memory:')
    database.prepare('SELECT 1').get()
    require('node-pty')
    return true
  } catch {
    return false
  } finally {
    database?.close()
  }
}

if (nativeModulesLoad()) process.exit(0)

console.warn(`Native module belum cocok dengan Node.js ${process.version}; menjalankan rebuild untuk web.`)

const npmNode = process.env.npm_node_execpath || process.execPath
const npmCli = process.env.npm_execpath
const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm'
const command = npmCli ? npmNode : npmCommand
const args = npmCli
  ? [npmCli, 'rebuild', 'better-sqlite3', 'node-pty', '--foreground-scripts', '--no-audit', '--no-fund']
  : ['rebuild', 'better-sqlite3', 'node-pty', '--foreground-scripts', '--no-audit', '--no-fund']
const result = spawnSync(command, args, { cwd: process.cwd(), env: process.env, stdio: 'inherit' })

if (result.error) {
  console.error(`Gagal menjalankan native rebuild: ${result.error.message}`)
  process.exit(1)
}

if (result.status !== 0 || !nativeModulesLoad()) {
  console.error('Native module tetap tidak dapat dimuat. Jalankan `npm run web:rebuild-native` dengan Node.js yang sama.')
  process.exit(result.status ?? 1)
}

process.exit(result.status ?? 1)
