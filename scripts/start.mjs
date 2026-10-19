#!/usr/bin/env node
/**
 * npm start: runs the bridge (the brain) and the face together, waits until
 * both answer, then opens the face as a Chrome app window:
 *
 *   open -na "Google Chrome" --args --app=http://127.0.0.1:5173/#t=<token>
 *
 * The face is the production build (built here when src/ has changed, about
 * 20 seconds) served by `vite preview` on 127.0.0.1:5173. Not "localhost":
 * on a Mac that tries [::1] first, where another project's dev server may sit.
 *
 * The token is made fresh for every start. The bridge only accepts the window
 * that carries it (see bridge/access.mjs). It is also kept in
 * ~/.donevia-jarvis/session.json (readable only by you) so a second
 * double-click can reopen the window while Jarvis is running.
 *
 * Ctrl-C (or closing the Terminal window) stops both.
 *
 *   --no-open   start the servers but do not open Chrome
 *
 * Forked from upstream's launcher; the MediaPipe vendoring and the --writes
 * flag are gone (there is no camera and no writes mode).
 */
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir, platform } from 'node:os'
import process from 'node:process'
import { newToken } from '../bridge/access.mjs'
import { BUILD_STAMP, faceBuildCurrent, faceFingerprint } from './face-build.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const FACE_URL = 'http://127.0.0.1:5173'
const SESSION_FILE = join(homedir(), '.donevia-jarvis', 'session.json')
const noOpen = process.argv.includes('--no-open')
const tty = process.stdout.isTTY
const paintWith = (code) => (s) => (tty ? `\x1b[${code}m${s}\x1b[0m` : s)
const pink = paintWith('38;2;255;45;175')
const violet = paintWith('38;2;155;107;255')
const dim = paintWith('2')

if (!existsSync(join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js')) || !existsSync(join(ROOT, 'node_modules', '@anthropic-ai', 'claude-agent-sdk', 'package.json'))) {
  console.error('\n  Packages are not installed (or the install was interrupted).')
  console.error('  Double-click "Start Cortana.command" again, or run:  npm ci\n')
  process.exit(1)
}

let bridgePort = 8787
try {
  const { config } = await import('../bridge/env.mjs')
  bridgePort = config.port
} catch {
  /* default */
}

const prefix = (tag, paint) => (chunk) =>
  chunk
    .toString()
    .split('\n')
    .filter((l) => l.length)
    .map((l) => `${paint(tag)} ${l}`)
    .join('\n')

const children = []
let stopping = false

function run(name, cmd, args, paint, env = process.env) {
  const child = spawn(cmd, args, { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] })
  const tag = name.padEnd(6)
  child.stdout.on('data', (d) => console.log(prefix(tag, paint)(d)))
  child.stderr.on('data', (d) => console.error(prefix(tag, paint)(d)))
  child.on('exit', (code) => {
    if (stopping) return
    console.error(`\n  ${name} stopped (code ${code}). Stopping Jarvis.`)
    stop(code ?? 1)
  })
  children.push(child)
  return child
}

function stop(code = 0) {
  if (stopping) return
  stopping = true
  forgetSession()
  for (const c of children) {
    try {
      c.kill('SIGTERM')
    } catch {
      /* gone */
    }
  }
  setTimeout(() => process.exit(code), 400)
}
process.on('SIGINT', () => stop(0))
process.on('SIGTERM', () => stop(0))
process.on('SIGHUP', () => stop(0))

async function waitFor(url, ms) {
  const until = Date.now() + ms
  while (Date.now() < until) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(1500) })
      if (res.ok) return true
    } catch {
      /* not yet */
    }
    await new Promise((r) => setTimeout(r, 400))
  }
  return false
}

function openFace(token) {
  const url = `${FACE_URL}/#t=${token}`
  if (noOpen) {
    console.log(dim(`  Not opening Chrome (--no-open). The face is at ${url}`))
    return
  }
  if (platform() === 'darwin') {
    const r = spawnSync('open', ['-na', 'Google Chrome', '--args', `--app=${url}`])
    if (r.status !== 0) {
      console.log('  Could not open Google Chrome; opening the default browser instead (voice works best in Chrome).')
      spawnSync('open', [url])
    }
  } else {
    console.log(`  Open ${url} in Google Chrome.`)
  }
}

function readSession() {
  try {
    const s = JSON.parse(readFileSync(SESSION_FILE, 'utf8'))
    process.kill(s.pid, 0) // throws if that launcher is gone
    return s
  } catch {
    return null
  }
}

function forgetSession() {
  try {
    if (readSession()?.pid === process.pid) rmSync(SESSION_FILE)
  } catch {
    /* already gone */
  }
}

// Already running (a second double-click, or the LaunchAgent): just show it.
const [already, alreadyFace] = await Promise.all([
  waitFor(`http://127.0.0.1:${bridgePort}/health`, 800),
  waitFor('http://127.0.0.1:5173/', 800),
])
if (already && alreadyFace) {
  const running = readSession()
  if (running?.token) {
    console.log('\n  Cortana is already running. Opening it.\n')
    openFace(running.token)
  } else {
    console.log('\n  Cortana is already running in another Terminal window.')
    console.log('  Close that window (or press Ctrl-C in it), then start Jarvis again.\n')
  }
  process.exit(0)
}

const TOKEN = newToken()
try {
  mkdirSync(dirname(SESSION_FILE), { recursive: true, mode: 0o700 })
  writeFileSync(SESSION_FILE, JSON.stringify({ pid: process.pid, port: bridgePort, token: TOKEN }), { mode: 0o600 })
} catch {
  /* only needed to reopen the window from a second launch */
}

console.log(`\n  ${pink('CORTANA')}  ${dim('starting…  (Ctrl-C to stop)')}\n`)

// The bridge port is built into the face (its bridge address and CSP).
const faceEnv = { ...process.env, JARVIS_BRIDGE_PORT: String(bridgePort) }
const VITE = join('node_modules', 'vite', 'bin', 'vite.js')
if (!faceBuildCurrent(ROOT, bridgePort)) {
  console.log(dim('  Preparing the face (about 20 seconds after an install or update)…'))
  const b = spawnSync(process.execPath, [VITE, 'build', '--logLevel', 'warn'], { cwd: ROOT, env: faceEnv, encoding: 'utf8' })
  if (b.status !== 0) {
    console.error(`${b.stdout ?? ''}${b.stderr ?? ''}`.trim().split('\n').slice(-12).join('\n'))
    console.error('\n  The face could not be built. Double-click "Start Cortana.command" again (it repairs the')
    console.error('  packages if they are the problem), or run  npm run setup  to see what is wrong.\n')
    forgetSession()
    process.exit(1)
  }
  try {
    writeFileSync(join(ROOT, BUILD_STAMP), `${faceFingerprint(ROOT, bridgePort)}\n`)
  } catch {
    /* rebuilds next time; harmless */
  }
}

run('bridge', process.execPath, [join('bridge', 'server.mjs')], pink, { ...process.env, JARVIS_TOKEN: TOKEN })
run('face', process.execPath, [VITE, 'preview', '--strictPort', '--clearScreen', 'false'], violet, faceEnv)

const [bridgeUp, faceUp] = await Promise.all([
  waitFor(`http://127.0.0.1:${bridgePort}/health`, 45000),
  waitFor('http://127.0.0.1:5173/', 45000),
])

if (!bridgeUp || !faceUp) {
  console.error(`\n  ${!bridgeUp ? 'The bridge' : 'The face'} did not start. Run  npm run setup  to see why.\n`)
  stop(1)
} else {
  console.log(`\n  ${pink('Ready.')} ${FACE_URL}\n`)
  openFace(TOKEN)
  console.log(dim('  Click the window, allow the microphone once, then press Space or say "Cortana".\n'))
}
