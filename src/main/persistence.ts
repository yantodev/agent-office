import fs from 'node:fs'
import { randomUUID } from 'node:crypto'

export function writeJsonAtomic(path: string, value: unknown) {
  const temporaryPath = `${path}.${randomUUID()}.tmp`
  fs.writeFileSync(temporaryPath, JSON.stringify(value, null, 2), 'utf8')
  fs.renameSync(temporaryPath, path)
}

export function writeTextAtomic(path: string, value: string) {
  const temporaryPath = `${path}.${randomUUID()}.tmp`
  fs.writeFileSync(temporaryPath, value, 'utf8')
  fs.renameSync(temporaryPath, path)
}
