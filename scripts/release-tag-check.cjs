const version = require('../package.json').version
const tag = process.env.RELEASE_TAG
const expectedTag = `v${version}`

if (!tag || !/^v\d+\.\d+\.\d+$/.test(tag) || tag !== expectedTag) {
  console.error(`Release tag harus cocok dengan package.json: ${expectedTag}`)
  process.exit(1)
}

console.log(`Release tag valid: ${tag}`)
