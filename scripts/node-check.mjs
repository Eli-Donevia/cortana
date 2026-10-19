#!/usr/bin/env node
/**
 * Is this Node.js new enough for Jarvis?
 *
 * The face is built with Vite 8, which needs Node 20.19+ or 22.12+ (an older
 * 20.x, 21.x or 22.0-22.11 crashes when the face starts). Run by the .command
 * before it downloads anything, and by `npm run setup`. Written in plain old
 * JavaScript so it runs, and explains itself, on any Node.
 *
 *   node scripts/node-check.mjs   exit 0 if fine; otherwise print the fix, exit 1
 */
export const NODE_RANGE = 'Node 22.12 or newer, or 20.19+ on the 20 line'

export function nodeOk(version) {
  var m = /^v?(\d+)\.(\d+)/.exec(String(version))
  if (!m) return false
  var major = Number(m[1])
  var minor = Number(m[2])
  if (major === 20) return minor >= 19
  if (major === 22) return minor >= 12
  return major >= 23
}

export const NODE_FIX =
  'Install the current Node.js "LTS" for macOS from https://nodejs.org (download, open, click through), ' +
  'then close this window and start Jarvis again.'

if (process.argv[1] && /node-check\.mjs$/.test(process.argv[1])) {
  if (!nodeOk(process.versions.node)) {
    console.log('')
    console.log('  Node.js ' + process.versions.node + ' is too old for Jarvis (it needs ' + NODE_RANGE + ').')
    console.log('  ' + NODE_FIX)
    process.exit(1)
  }
}
