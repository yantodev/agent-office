const version = require('../package.json').version
const tag = process.env.RELEASE_TAG
const expectedTag = `v${version}`
const semverTagPattern = /^v\d+\.\d+\.\d+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/

if (!tag || !semverTagPattern.test(tag) || tag !== expectedTag) {
  console.error(`Release tag harus cocok dengan package.json: ${expectedTag}`)
  process.exit(1)
}

console.log(`Release tag valid: ${tag}`)
