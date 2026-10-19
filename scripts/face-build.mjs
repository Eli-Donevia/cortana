/**
 * The face is served from a production build (vite build + vite preview), not
 * Vite's dev server: the built page has no inline scripts, so its CSP can
 * refuse them (index.html). This module says whether dist/ is current.
 *
 * The fingerprint covers what the build reads: src/, public/, index.html, the
 * Vite and TypeScript config, the lockfile, and the bridge port (the face's
 * bridge address and CSP are built with it).
 */
import { createHash } from 'node:crypto'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

export const BUILD_STAMP = join('dist', '.jarvis-build')

const INPUTS = ['src', 'public', 'index.html', 'vite.config.ts', 'package-lock.json', 'tsconfig.app.json']

function walk(root, rel, out) {
  const p = join(root, rel)
  let st
  try {
    st = statSync(p)
  } catch {
    return
  }
  if (st.isDirectory()) {
    for (const name of readdirSync(p).sort()) walk(root, join(rel, name), out)
  } else {
    out.push(`${relative(root, p)}:${st.size}:${Math.floor(st.mtimeMs)}`)
  }
}

export function faceFingerprint(root, bridgePort) {
  const lines = []
  for (const i of INPUTS) walk(root, i, lines)
  lines.push(`port:${bridgePort}`)
  return createHash('sha256').update(lines.join('\n')).digest('hex').slice(0, 24)
}

export function faceBuildCurrent(root, bridgePort) {
  try {
    return readFileSync(join(root, BUILD_STAMP), 'utf8').trim() === faceFingerprint(root, bridgePort)
  } catch {
    return false
  }
}
