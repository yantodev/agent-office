const { spawnSync } = require('node:child_process')
const electron = require('electron')
const path = require('node:path')

const result = spawnSync(electron, ['-e', `require(${JSON.stringify(path.resolve(__dirname, 'main-smoke-run.cjs'))})`], {
  env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  encoding: 'utf8',
  stdio: 'inherit'
})

process.exit(result.status ?? 1)
