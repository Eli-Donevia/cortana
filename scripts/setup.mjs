#!/usr/bin/env node
/**
 * npm run setup: checks this Mac is ready for Donevia Jarvis and says, in
 * plain words, what to fix. Changes nothing and spends no Claude usage.
 *
 *   node scripts/setup.mjs              full report
 *   node scripts/setup.mjs --brief      only problems
 *   node scripts/setup.mjs --launcher   only problems, worded for the
 *                                       double-click launcher (which signs
 *                                       in by itself when that is all that
 *                                       is missing)
 *
 * Exit codes: 0 ready; 1 something blocks Jarvis from starting; 2 the only
 * thing missing is the Claude sign-in (the .command then runs `npm run login`).
 */
import { existsSync, readdirSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { homedir, platform } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import net from 'node:net'
import { bundledClaude, installState } from './install-state.mjs'
import { nodeOk, NODE_RANGE, NODE_FIX } from './node-check.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const launcher = process.argv.includes('--launcher')
const brief = launcher || process.argv.includes('--brief')
const tty = process.stdout.isTTY
const c = (code) => (s) => (tty ? `\x1b[${code}m${s}\x1b[0m` : s)
const pink = c('38;2;255;45;175')
const dim = c('2')
const green = c('32')
const amber = c('33')
const red = c('31')

const fixes = []
let blocked = false
/** True when the only blocking problem is the Claude sign-in. */
let loginOnly = false
let otherBlock = false

function ok(label, detail = '') {
  if (!brief) console.log(`  ${green('ok')}    ${label}${detail ? dim(`  ${detail}`) : ''}`)
}
function warn(label, detail, fix) {
  console.log(`  ${amber('note')}  ${label}${detail ? dim(`  ${detail}`) : ''}`)
  if (fix) fixes.push(fix)
}
function fail(label, detail, fix, { login = false } = {}) {
  console.log(`  ${red('fix')}   ${label}${detail ? dim(`  ${detail}`) : ''}`)
  if (fix) fixes.push(fix)
  blocked = true
  if (login) loginOnly = true
  else otherBlock = true
}

const REINSTALL =
  'Reinstall the packages: double-click "Start Cortana.command" again (it reinstalls by itself), ' +
  'or in Terminal, in the donevia-jarvis folder, run:  rm -rf node_modules && npm ci'
const LOGIN =
  'Sign in to Claude: double-click "Start Cortana.command" again and it will open the sign-in page, ' +
  'or run  npm run login  in the donevia-jarvis folder. Choose your Claude account (the one that owns Donevia HQ).'

const run = (cmd, args) => {
  const r = spawnSync(cmd, args, { encoding: 'utf8', timeout: 15000 })
  return r.status === 0 ? (r.stdout || '').trim() : null
}

/**
 * Can we listen on `port` at `host`? An address this Mac does not have (no
 * IPv6 loopback) counts as free: nothing can be listening there either.
 */
const canListen = (port, host) =>
  new Promise((resolve) => {
    const s = net.createServer()
    s.once('error', (err) => resolve(err?.code === 'EADDRNOTAVAIL' || err?.code === 'EAFNOSUPPORT'))
    s.once('listening', () => s.close(() => resolve(true)))
    s.listen({ port, host, ipv6Only: host === '::1' })
  })

async function reachable(url) {
  try {
    const res = await fetch(url, { method: 'GET', signal: AbortSignal.timeout(6000) })
    return res.ok || res.status < 500
  } catch {
    return false
  }
}

console.log(`\n  ${pink('CORTANA')}  ${dim('setup check')}\n`)

// 1. The Mac and Node -------------------------------------------------------

if (platform() !== 'darwin') {
  warn('Not a Mac', `(${platform()})`, 'Jarvis is built for macOS. Other systems may work, but `npm start` opens Chrome the Mac way.')
}

if (nodeOk(process.versions.node)) ok('Node.js', `v${process.versions.node}`)
else fail('Node.js is too old', `v${process.versions.node} (Jarvis needs ${NODE_RANGE})`, NODE_FIX)

const install = installState(ROOT)
if (install.ok) ok('Packages installed')
else fail('Packages are not fully installed', install.problems.join('; '), REINSTALL)

// 2. Chrome ------------------------------------------------------------------

const chromeApps = ['/Applications/Google Chrome.app', join(homedir(), 'Applications', 'Google Chrome.app')]
const chrome = chromeApps.find((p) => existsSync(p))
if (!chrome && platform() === 'darwin') {
  fail('Google Chrome not found', '', 'Install Google Chrome from https://www.google.com/chrome and drag it into Applications. Jarvis needs Chrome for its voice and microphone.')
} else if (chrome) {
  const v = run(join(chrome, 'Contents', 'MacOS', 'Google Chrome'), ['--version']) ?? ''
  const cv = Number((/(\d+)\./.exec(v) ?? [])[1] || 0)
  if (cv && cv < 139) {
    warn('Google Chrome is old', v, 'Update Chrome (Chrome menu > About Google Chrome). Newer Chrome can hear "Jarvis" on the Mac itself; older Chrome means pressing Space to talk.')
  } else ok('Google Chrome', v.replace(/^Google Chrome\s*/, ''))
}

// 3. Claude Code and the login ------------------------------------------------

// Jarvis runs the copy of Claude Code that comes with its packages, so a
// separate install is not needed; only the sign-in is.
const claudeBin = bundledClaude(ROOT)
const claudeVersion = claudeBin ? run(claudeBin, ['--version']) : null
if (claudeVersion) ok('Claude Code', claudeVersion.split('\n')[0])
else if (install.ok) fail('Claude Code would not start', claudeBin ?? '', REINSTALL)

if (process.env.ANTHROPIC_API_KEY) {
  warn('ANTHROPIC_API_KEY is set in this shell', '(Jarvis ignores it and uses your claude.ai login)', null)
}

let dataPath = null
if (install.ok) {
  try {
    const { childEnv, config } = await import('../bridge/env.mjs')
    const { probeDataPath, readLocalServers, sessionOptions } = await import('../bridge/probe.mjs')
    const { mkdirSync } = await import('node:fs')
    mkdirSync(config.workDir, { recursive: true })
    if (!brief) console.log(dim('        checking your Claude login and data sources (no usage spent)…'))
    dataPath = await probeDataPath({ options: sessionOptions(childEnv().env), localServers: readLocalServers() })
  } catch (err) {
    fail('Could not run the data check', String(err?.message ?? err).slice(0, 160), REINSTALL)
  }
}

if (dataPath) {
  const who = dataPath.account?.email ?? 'claude.ai account'
  const loginNotes = /could not be started|not signed in|API key or another provider|not reported yet/
  switch (dataPath.login) {
    case 'claude-ai':
      ok('Signed in', `${who}${dataPath.account?.subscription ? ` (${dataPath.account.subscription})` : ''}`)
      break
    case 'signed-out':
      fail('Not signed in to Claude', '', LOGIN, { login: true })
      break
    case 'other-provider':
      fail('Claude Code is signed in with an API key or another provider, not your claude.ai account',
        dataPath.account?.apiKeySource ? `(${dataPath.account.apiKeySource})` : '',
        `${LOGIN} If you set ANTHROPIC_API_KEY or CLAUDE_CODE_USE_BEDROCK yourself, Jarvis already ignores them.`,
        { login: true })
      break
    default: {
      // Claude Code did not start or did not answer: signing in again would not help.
      const why = (dataPath.notes.find((n) => /could not be started|not reported/.test(n)) ?? '').replace(/^Claude Code could not be started or did not answer: /, '')
      fail('Claude Code could not be started to check the sign-in', why.slice(0, 200), REINSTALL)
    }
  }

  const label = {
    'hq-db': 'HQ database (best)',
    connectors: 'claude.ai connectors (HQ database not confirmed yet)',
    'local-mcp': 'MCP servers from ~/.claude.json only',
    none: 'none',
  }[dataPath.active]
  if (dataPath.active === 'none') {
    if (dataPath.login === 'claude-ai')
      fail('No data source found', '',
        'Jarvis could not see Donevia HQ or any connectors. Check that this is the account that owns HQ, and that Gmail, Google Calendar, Notion, Granola and Attio are connected at claude.ai > Settings > Connectors.')
  } else ok('Data path', label)
  if (dataPath.hqDb === 'expected')
    warn('HQ database', 'expected; confirmed on your first question', null)
  if (dataPath.connectors.length) ok('Connectors (read-only)', dataPath.connectors.join(', '))
  if (dataPath.localMcp.length) ok('Local MCP (read-only)', dataPath.localMcp.join(', '))
  for (const n of dataPath.notes) {
    if (loginNotes.test(n) || /expected; confirmed/.test(n)) continue
    warn('Note', n, /Reconnect|update Claude Code/.test(n) ? n : null)
  }
}

// Conversations from before Jarvis stopped keeping transcripts.
try {
  const projects = join(homedir(), '.claude', 'projects')
  const old = readdirSync(projects).filter((d) => d.includes('donevia-jarvis-work'))
  if (old.length) {
    warn('Old Jarvis transcripts on this Mac', `(${old.length} folder${old.length > 1 ? 's' : ''})`,
      `Jarvis no longer saves conversations, but earlier ones are in ${old.map((d) => join(projects, d)).join(', ')}. ` +
        'To remove them: in Finder choose Go > Go to Folder, paste that path, and drag the folder to the Trash.')
  }
} catch {
  /* no ~/.claude/projects */
}

// 4. Settings and voice --------------------------------------------------------

let env = {}
try {
  const { readSettings, SETTINGS_FILES } = await import('../bridge/env.mjs')
  const s = readSettings(ROOT)
  env = s.values
  for (const p of s.problems) fail('Settings file cannot be read', '', p)
  if (s.found.length && !s.problems.length) ok('Settings', s.found.map((f) => `"${f}"`).join(' and '))
  else if (!s.found.length && !brief) ok('Settings', `defaults (npm run settings makes "${SETTINGS_FILES[0]}")`)
} catch {
  /* defaults */
}
const engine = process.env.JARVIS_TTS_ENGINE || env.JARVIS_TTS_ENGINE || 'kokoro'
if (engine === 'kokoro') {
  if (!existsSync(join(ROOT, 'node_modules', 'kokoro-js'))) {
    warn('Kokoro voice package missing', '', 'Run npm install in the donevia-jarvis folder.')
  } else if (await reachable('https://huggingface.co/api/models/onnx-community/Kokoro-82M-v1.0-ONNX')) {
    ok('Kokoro voice', 'downloads once on first start (90-330 MB), then works offline')
  } else {
    warn('Kokoro voice model cannot be downloaded right now', '(huggingface.co unreachable)',
      'Jarvis will speak with the macOS voice until it can reach huggingface.co. Nothing to do unless that lasts; a VPN or firewall may be blocking it.')
  }
} else ok('Voice', 'macOS system voice (JARVIS_TTS_ENGINE=system)')

const key = process.env.PICOVOICE_ACCESS_KEY || env.PICOVOICE_ACCESS_KEY
if (key) {
  if (existsSync(join(ROOT, 'public', 'picovoice', 'porcupine_params.pv'))) ok('Porcupine wake word', 'key and model file present')
  else
    warn('Porcupine key set, but the model file is missing', '',
      'Follow public/picovoice/README.md to download porcupine_params.pv, or remove PICOVOICE_ACCESS_KEY from your settings (npm run settings). Until then Jarvis uses Chrome for the wake word.')
} else ok('Wake word', 'Chrome on-device if available, otherwise press Space')

// 5. Ports ------------------------------------------------------------------

const bridgePort = Number(process.env.JARVIS_BRIDGE_PORT || env.JARVIS_BRIDGE_PORT || 8787)
const ours = async (url, marker) => {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(2000) })
    return res.ok && (await res.text()).includes(marker)
  } catch {
    return false
  }
}
for (const [port, what, url, marker] of [
  [bridgePort, 'bridge', `http://127.0.0.1:${bridgePort}/health`, '"app":"donevia-jarvis"'],
  [5173, 'face', 'http://127.0.0.1:5173/', 'Cortana'],
]) {
  const fix =
    port === bridgePort
      ? `Quit the program using port ${port} (or restart the Mac). Or give Jarvis another port: run  npm run settings  and set JARVIS_BRIDGE_PORT=8788.`
      : `Quit the program using port ${port} (often another web project started with npm run dev), or restart the Mac.`
  if (await canListen(port, '127.0.0.1')) ok(`Port ${port} free`, `(${what})`)
  else if (await ours(url, marker)) ok(`Jarvis ${what} already running`, `(port ${port})`)
  else fail(`Port ${port} is in use by another program`, `(Jarvis needs it for the ${what})`, fix)
  // "localhost" on a Mac tries [::1] first. Jarvis always uses 127.0.0.1, so a
  // dev server on [::1] cannot take its place, but it is worth knowing.
  if (!(await canListen(port, '::1'))) {
    warn(`Another program is on [::1]:${port}`, '(localhost)',
      `Jarvis is unaffected (it uses 127.0.0.1:${port}), but http://localhost:${port} shows that other program, not Jarvis. ${fix}`)
  }
}

// Summary -------------------------------------------------------------------

console.log('')
// From the launcher with only the sign-in missing, the sign-in opens next by
// itself, so there is nothing for Eli to do yet.
const quietLogin = launcher && loginOnly && !otherBlock
if (fixes.length && !quietLogin) {
  console.log(`  ${pink('What to do')}`)
  fixes.forEach((f, i) => console.log(`  ${i + 1}. ${f}`))
  console.log('')
}
const signInOnly = loginOnly && !otherBlock
if (blocked) {
  // From the launcher: one instruction, never two. When only the sign-in is
  // missing, the launcher opens it next, so say just that.
  if (launcher && signInOnly) {
    /* the sign-in line above says it all; login.mjs takes over */
  } else if (launcher) console.log(`  ${red('Not ready yet.')} Fix the items above, then double-click "Start Cortana" again.\n`)
  else console.log(`  ${red('Not ready yet.')} Fix the numbered items, then run ${pink('npm run setup')} again.\n`)
  process.exit(signInOnly ? 2 : 1)
} else {
  if (!brief) console.log(`  ${green('Ready.')} Start Cortana with ${pink('npm start')} or double-click "Start Cortana.command".\n`)
  process.exit(0)
}
