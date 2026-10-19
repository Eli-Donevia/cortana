/**
 * Runtime settings, read when the bridge starts.
 *
 * Settings come from the shell first, then from "Jarvis settings.txt" in the
 * project root (the easy one: visible in Finder, made by `npm run settings`),
 * then from .env.local (the developer one). Neither is ever committed; both
 * use the KEY=value lines of .env.example. Nothing here is baked into the
 * browser bundle except the bridge port: the face asks the bridge for /config
 * at boot, so changing a setting needs a restart of Jarvis, not a rebuild.
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'
import { DEFAULT_HQ_URL } from './policy.mjs'

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

/** The settings files, most important first. */
export const SETTINGS_FILES = ['Jarvis settings.txt', '.env.local']

/**
 * Minimal KEY=value parser: comments, blank lines, optional quotes.
 * Forgiving of what TextEdit does to a file: smart (curly) quotes, non-breaking
 * spaces and Windows or old-Mac line endings all read as the plain versions.
 */
export function parseEnv(text) {
  const out = {}
  const plain = String(text)
    .replace(/^\ufeff/, '')
    .replace(/[\u201C\u201D\u201E\u201F\u2033]/g, '"')
    .replace(/[\u2018\u2019\u201A\u201B\u2032]/g, "'")
    .replace(/[\u00a0\u2007\u202f]/g, ' ')
    .replace(/[\u200b\u2060]/g, '')
  for (const raw of plain.split(/\r\n|\r|\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line)
    if (!m) continue
    let v = m[2].trim()
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1)
    else v = v.replace(/\s+#.*$/, '')
    out[m[1]] = v
  }
  return out
}

/** Rich text (TextEdit's default) instead of plain text. */
export const isRichText = (text) => /^\s*\{\\rtf/.test(String(text))

/**
 * Read the settings files in `root`. Returns the merged values (earlier files
 * win) and a list of problems a person can fix, e.g. a file saved as rich text.
 */
export function readSettings(root = ROOT) {
  const values = {}
  const problems = []
  const found = []
  for (const name of [...SETTINGS_FILES].reverse()) {
    let text
    try {
      text = readFileSync(join(root, name), 'utf8')
    } catch {
      continue
    }
    found.unshift(name)
    if (isRichText(text)) {
      problems.push(`"${name}" was saved as rich text, so Jarvis cannot read it. Open it in TextEdit, choose Format > Make Plain Text, and save.`)
      continue
    }
    Object.assign(values, parseEnv(text))
  }
  return { values, problems, found }
}

const SETTINGS = readSettings()
const FILE = SETTINGS.values
export const settingsProblems = SETTINGS.problems
export const settingsFiles = SETTINGS.found

/** Shell wins over .env.local; blank counts as unset. */
export function setting(name, fallback = '') {
  const v = process.env[name] ?? FILE[name]
  return v === undefined || String(v).trim() === '' ? fallback : String(v).trim()
}

/**
 * Kokoro voices the settings file accepts. Same ids, same order as
 * src/lib/kokoroVoices.ts (a test keeps them equal); V in the face cycles
 * them live.
 */
export const KOKORO_VOICES = [
  'bf_emma', 'bf_isabella', 'bm_george', 'af_heart', 'af_bella', 'am_michael',
  'am_fenrir', 'af_nicole', 'am_puck', 'bm_fable', 'bm_lewis', 'bm_daniel',
]

const oneOf = (name, allowed, fallback) => {
  const v = setting(name, fallback)
  if (allowed.includes(v)) return v
  console.warn(`[jarvis] ${name}="${v}" is not one of ${allowed.join(' | ')}; using "${fallback}".`)
  return fallback
}

export const config = {
  port: Number(setting('JARVIS_BRIDGE_PORT', '8787')),
  hqUrl: setting('DONEVIA_HQ_URL', DEFAULT_HQ_URL),
  // Spoken answers run on the fastest model; deeper questions go to the researcher.
  model: setting('JARVIS_MODEL', 'claude-haiku-5-5'),
  effort: oneOf('JARVIS_EFFORT', ['low', 'medium', 'high', 'xhigh', 'max'], 'low'),
  deepModel: setting('JARVIS_DEEP_MODEL', 'opus'),
  deepEffort: oneOf('JARVIS_DEEP_EFFORT', ['low', 'medium', 'high', 'xhigh', 'max'], 'high'),
  maxTurns: Math.max(2, Math.min(16, Number(setting('JARVIS_MAX_TURNS', '8')) || 8)),
  workDir: setting('JARVIS_WORK_DIR', join(homedir(), '.donevia-jarvis', 'work')),
  // The one folder Cortana may list and rearrange (bridge/files.mjs).
  filesDir: setting('JARVIS_FILES_DIR', join(homedir(), 'Documents', 'Donevia')),
  // Voice settings the face reads from /config.
  ttsEngine: oneOf('JARVIS_TTS_ENGINE', ['kokoro', 'system'], 'kokoro'),
  kokoroVoice: oneOf('JARVIS_KOKORO_VOICE', KOKORO_VOICES, 'bf_emma'),
  kokoroDevice: oneOf('JARVIS_KOKORO_DEVICE', ['auto', 'webgpu', 'wasm'], 'auto'),
  wake: oneOf('JARVIS_WAKE', ['auto', 'on-device', 'cloud', 'off'], 'auto'),
  // What cuts her off mid-sentence: her name only, her name or a stop word
  // ("stop", "wait", "hold on"), or any speech (best with headphones).
  barge: oneOf('JARVIS_BARGE', ['name', 'words', 'any'], 'words'),
  // Speaking first: meeting nudges and alerts (bridge/proactive.mjs). Eli said yes, Oct 19.
  proactive: setting('JARVIS_PROACTIVE', '1') !== '0',
  quietHours: setting('JARVIS_QUIET_HOURS', '22:30-07:00'),
  alertMinutes: Math.max(5, Number(setting('JARVIS_ALERT_MINUTES', '20')) || 20),
  picovoiceKey: setting('PICOVOICE_ACCESS_KEY', ''),
  allowNoOrigin: setting('JARVIS_ALLOW_NO_ORIGIN', '0') === '1',
  extraOrigins: setting('JARVIS_ALLOWED_ORIGINS', '')
    .split(',')
    .map((s) => s.trim().replace(/\/+$/, ''))
    .filter(Boolean),
  debug: setting('JARVIS_DEBUG', '0') === '1',
}

/**
 * Variables that would switch Claude Code off Eli's claude.ai login. With any
 * of them set, connectors and the HQ database disappear and usage bills to an
 * API key instead, so the bridge removes them from the session's environment
 * unless JARVIS_KEEP_API_KEY=1.
 */
export const AUTH_OVERRIDES = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'ENABLE_CLAUDEAI_MCP_SERVERS',
  'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC',
]

/** The environment for the Claude Code child process. */
export function childEnv(base = process.env) {
  const env = { ...base }
  const removed = []
  if (setting('JARVIS_KEEP_API_KEY', '0') !== '1') {
    for (const k of AUTH_OVERRIDES) {
      if (env[k] !== undefined) {
        delete env[k]
        removed.push(k)
      }
    }
  }
  // Turns on the artifact tools in headless Claude Code and exposes the
  // database as its own ArtifactData tool (see README, "How it reads HQ").
  env.CLAUDE_CODE_ARTIFACT = '1'
  env.CLAUDE_CODE_ARTIFACT_TOOLSET = '1'
  // No bundled skills or workflows. Built-in slash commands stay typable, which
  // is why the bridge also refuses any question starting with "/" (ask.mjs).
  env.CLAUDE_CODE_DISABLE_BUNDLED_SKILLS = '1'
  env.CLAUDE_AGENT_SDK_CLIENT_APP = 'donevia-jarvis/1.0'
  // The launch token is for the face, never for Claude Code.
  delete env.JARVIS_TOKEN
  return { env, removed }
}
