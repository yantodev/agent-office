import fs from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'

export function canonicalPath(path: string) {
  let current = resolve(path)
  const tail: string[] = []
  while (!fs.existsSync(current)) {
    const parent = dirname(current)
    if (parent === current) return resolve(path)
    tail.unshift(basename(current))
    current = parent
  }
  try { return join(fs.realpathSync.native(current), ...tail) } catch { return resolve(path) }
}

export function isCanonicalPathInside(parent: string, candidate: string) {
  const root = canonicalPath(parent).replace(/[\\/]$/, '')
  const target = canonicalPath(candidate)
  return target === root || target.startsWith(`${root}${target.includes('\\') ? '\\' : '/'}`)
}

export function redactSecrets(value: string) {
  return value
    .replace(/\b(?:sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9_]{12,}|xox[baprs]-[A-Za-z0-9-]{12,})\b/g, '[REDACTED_SECRET]')
    .replace(/\b((?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|secret|credential|token)\s*[:=]\s*)([^\s,;]+)/gi, '$1[REDACTED]')
    .replace(/((?:["']?\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|secret|credential|token)\b["']?)\s*[:=]\s*["']?)([^"'\s,;}]+)(["']?)/gi, '$1[REDACTED]$3')
}
