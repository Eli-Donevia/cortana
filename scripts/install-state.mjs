/**
 * Is node_modules a complete install for this Mac?
 *
 * An interrupted `npm install` (Ctrl-C, Wi-Fi drop) or a node_modules copied
 * from another machine leaves a folder that looks installed but is not. The
 * launcher writes a stamp after a successful install; this module says whether
 * the stamp matches this platform and package-lock.json, and whether the files
 * Jarvis actually runs are there.
 */
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

export const STAMP = join('node_modules', '.jarvis-install')

/** e.g. "darwin-arm64 3f2a..." : platform, CPU and a hash of the lockfile. */
export function expectedStamp(root, platform = process.platform, arch = process.arch) {
  let lock = ''
  try {
    lock = createHash('sha256').update(readFileSync(join(root, 'package-lock.json'))).digest('hex').slice(0, 16)
  } catch {
    lock = 'no-lock'
  }
  return `${platform}-${arch} ${lock}`
}

/** The Claude Code binary that ships with the Agent SDK for this platform. */
export function bundledClaude(root, platform = process.platform, arch = process.arch) {
  const names = [`${platform}-${arch}`]
  if (platform === 'linux') names.push(`${platform}-${arch}-musl`)
  for (const n of names) {
    const p = join(root, 'node_modules', '@anthropic-ai', `claude-agent-sdk-${n}`, platform === 'win32' ? 'claude.exe' : 'claude')
    if (existsSync(p)) return p
  }
  return null
}

/** { ok, problems[] } for the install in `root`. `files` only: skip the stamp. */
export function installState(root, { filesOnly = false } = {}) {
  const problems = []
  const need = [
    ['node_modules/vite/bin/vite.js', 'vite'],
    ['node_modules/@anthropic-ai/claude-agent-sdk/package.json', 'Claude Agent SDK'],
    ['node_modules/ws/package.json', 'ws'],
    ['node_modules/kokoro-js/package.json', 'kokoro-js'],
  ]
  for (const [rel, what] of need) {
    if (!existsSync(join(root, rel))) problems.push(`${what} is missing`)
  }
  if (!bundledClaude(root)) problems.push(`Claude Code for ${process.platform}-${process.arch} is missing`)
  if (filesOnly) return { ok: problems.length === 0, problems }
  let stamp = null
  try {
    stamp = readFileSync(join(root, STAMP), 'utf8').trim()
  } catch {
    /* none */
  }
  if (!stamp) problems.push('the last install did not finish')
  else if (stamp !== expectedStamp(root)) problems.push('packages were installed for another Mac or an older version')
  return { ok: problems.length === 0, problems }
}
