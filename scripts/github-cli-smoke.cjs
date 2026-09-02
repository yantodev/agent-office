const { spawnSync } = require('node:child_process')

const repository = process.env.GITHUB_REPOSITORY
if (!repository) {
  console.error('GitHub CLI smoke membutuhkan GITHUB_REPOSITORY dari workflow Actions')
  process.exit(1)
}

const environment = {
  ...process.env,
  // GH_TOKEN dipakai oleh gh tanpa menulis kredensial ke konfigurasi runner.
  GH_TOKEN: process.env.GH_TOKEN || process.env.GITHUB_TOKEN || ''
}

function runGh(args) {
  const result = spawnSync('gh', args, {
    env: environment,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  })
  if (result.error || result.status !== 0) {
    console.error(`GitHub CLI gagal pada perintah: gh ${args.join(' ')}`)
    if (result.error) console.error(result.error.message)
    else if (result.stderr.trim()) console.error(result.stderr.trim())
    process.exit(result.status || 1)
  }
  return result.stdout.trim()
}

runGh(['auth', 'status'])
const visibleRepository = runGh(['repo', 'view', repository, '--json', 'nameWithOwner', '--jq', '.nameWithOwner'])
if (visibleRepository !== repository) {
  console.error(`Repository terautentikasi tidak sesuai: ${visibleRepository || '(kosong)'}`)
  process.exit(1)
}

console.log(`GitHub CLI authenticated: ${repository}`)
