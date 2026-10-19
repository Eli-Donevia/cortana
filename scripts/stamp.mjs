#!/usr/bin/env node
/**
 * Called by the launcher after a successful `npm ci` / `npm install`, and by
 * `npm run setup -- --check-install` to decide whether to reinstall.
 *
 *   node scripts/stamp.mjs write   record that this install finished
 *   node scripts/stamp.mjs check   exit 0 if the install is complete, 1 if not
 */
import { writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { STAMP, expectedStamp, installState } from './install-state.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const cmd = process.argv[2]

if (cmd === 'write') {
  // Only a complete install gets a stamp.
  const s = installState(ROOT, { filesOnly: true })
  if (!s.ok) {
    console.error(`  The install is incomplete: ${s.problems.join('; ')}.`)
    process.exit(1)
  }
  writeFileSync(join(ROOT, STAMP), `${expectedStamp(ROOT)}\n`)
} else if (cmd === 'check') {
  const s = installState(ROOT)
  if (!s.ok && process.argv.includes('--why')) console.log(`  ${s.problems.join('; ')}`)
  process.exit(s.ok ? 0 : 1)
} else {
  console.error('usage: node scripts/stamp.mjs write|check [--why]')
  process.exit(2)
}
