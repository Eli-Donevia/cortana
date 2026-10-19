#!/usr/bin/env node
/**
 * npm run login: sign Claude Code in with your claude.ai account.
 *
 * Uses the copy of Claude Code that comes with Jarvis's packages, so nothing
 * else needs installing and nothing needs to be on your PATH. It opens the
 * browser; sign in with the claude.ai account that owns Donevia HQ.
 */
import { spawnSync } from 'node:child_process'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { bundledClaude } from './install-state.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const bin = bundledClaude(ROOT)
if (!bin) {
  console.error('\n  Claude Code is not installed with the packages yet. Double-click "Start Cortana.command" first.\n')
  process.exit(1)
}

console.log('\n  Signing in to Claude. A browser window will open: choose your Claude account')
console.log('  (the one that owns Donevia HQ) and approve. Then come back here.\n')

// Jarvis ignores these anyway; here they would make the login use an API key.
const env = { ...process.env }
for (const k of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN']) delete env[k]

const r = spawnSync(bin, ['auth', 'login', '--claudeai'], { stdio: 'inherit', env })
process.exit(r.status ?? 1)
