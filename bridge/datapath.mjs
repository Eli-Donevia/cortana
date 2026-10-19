/**
 * Which data path Jarvis is using, decided at boot and confirmed on the first
 * turn.
 *
 * Three paths, in order of preference:
 *   a. hq-db       The Donevia HQ database through Claude Code's ArtifactData
 *                  tool (needs the claude.ai login and the two
 *                  CLAUDE_CODE_ARTIFACT* switches the bridge sets).
 *   b. connectors  Eli's claude.ai connectors (Gmail, Calendar, Granola, Notion,
 *                  Attio), which Claude Code loads from the account.
 *   c. local-mcp   MCP servers configured in ~/.claude.json, read-only.
 *
 * At boot the bridge asks the SDK for account info and MCP server status
 * without sending a message, so nothing is spent. Whether ArtifactData exists
 * is only known from the session's init message, which arrives with the first
 * turn; until then a claude.ai login makes it "expected". Everything here is
 * pure so test/datapath.test.mjs can cover it.
 */

import { serviceOf, KNOWN_SERVICES, BLOCKED_SERVICES, READ_ALLOW } from './policy.mjs'

/** Services that make a connector path worth having. */
const DATA_SERVICES = ['gmail', 'calendar', 'granola', 'notion', 'attio']

const LIVE = new Set(['connected', 'pending'])

/** True when this login is a claude.ai subscription rather than an API key. */
export function isClaudeAiLogin(account) {
  if (!account) return false
  if (account.apiProvider && account.apiProvider !== 'firstParty') return false
  if (account.apiKeySource && account.apiKeySource !== 'none') return false
  const sub = String(account.subscriptionType ?? '').toLowerCase()
  if (sub.includes('api')) return false
  return Boolean(sub || account.email || /claude\.ai|oauth/i.test(String(account.tokenSource ?? '')))
}

/**
 * How Claude Code is signed in, in one word, so setup can give the right fix:
 *   claude-ai       a claude.ai subscription login (what Jarvis needs)
 *   signed-out      nobody signed in (Claude Code reports a bare "Claude API"
 *                   account with no email and no key)
 *   other-provider  an API key, Bedrock, Vertex or another provider
 *   unreadable      Claude Code could not be started or did not answer
 *   unknown         not asked yet
 */
export function loginState(account, authError = '') {
  if (authError) return 'unreadable'
  if (!account) return 'unknown'
  if (isClaudeAiLogin(account)) return 'claude-ai'
  if (account.apiProvider && account.apiProvider !== 'firstParty') return 'other-provider'
  if (account.apiKeySource && account.apiKeySource !== 'none') return 'other-provider'
  if (account.tokenSource && !/none/i.test(String(account.tokenSource))) return 'other-provider'
  return 'signed-out'
}

/** claude.ai connectors are named "claude.ai Gmail" (scope "claudeai"). */
export function isConnector(status) {
  return status?.scope === 'claudeai' || /^claude\.ai /i.test(String(status?.name ?? ''))
}

/** A short label: "claude.ai Google Calendar" -> "Google Calendar". */
export const labelOf = (name) => String(name).replace(/^claude\.ai\s+/i, '')

/**
 * @param {object} p
 * @param {object|null} p.account       accountInfo() result, or null
 * @param {Array|null}  p.mcpStatus     mcpServerStatus() result, or null
 * @param {string[]}    p.localServers  names passed from ~/.claude.json
 * @param {string[]|null} p.initTools   tools from the init message, or null before the first turn
 * @param {string}      [p.authError]   why the account could not be read
 */
export function classifyDataPath({ account = null, mcpStatus = null, localServers = [], initTools = null, authError = '' } = {}) {
  const status = Array.isArray(mcpStatus) ? mcpStatus : []
  const loggedIn = isClaudeAiLogin(account)
  const login = loginState(account, authError)
  // Signed out or on an API key, the tool may be listed but HQ cannot be read.
  const noHq = login === 'signed-out' || login === 'other-provider'

  let hqDb = 'unavailable'
  let hqTool = null
  if (noHq) {
    // stays unavailable
  } else if (Array.isArray(initTools)) {
    if (initTools.includes('ArtifactData')) {
      hqDb = 'confirmed'
      hqTool = 'ArtifactData'
    } else if (initTools.includes('Artifact')) {
      hqDb = 'confirmed'
      hqTool = 'Artifact'
    }
  } else if (loggedIn) {
    hqDb = 'expected'
    hqTool = 'Artifact'
  }

  const connectors = status
    .filter((s) => isConnector(s) && LIVE.has(s.status))
    .map((s) => labelOf(s.name))
  const connectorServices = new Set(connectors.map(serviceOf).filter(Boolean))
  const needsAuth = status
    .filter((s) => isConnector(s) && s.status === 'needs-auth')
    .map((s) => labelOf(s.name))

  const localSet = new Set(localServers)
  const local = status
    .filter((s) => !isConnector(s) && localSet.has(s.name) && LIVE.has(s.status))
    .map((s) => s.name)
  // Before the session has reported status, the configured names stand in.
  const localNames = status.length ? local : [...localSet]

  const hasConnectors = DATA_SERVICES.some((s) => connectorServices.has(s))
  const hasLocal = localNames.length > 0

  const active = hqDb !== 'unavailable'
    ? 'hq-db'
    : hasConnectors
      ? 'connectors'
      : hasLocal
        ? 'local-mcp'
        : 'none'

  const notes = []
  if (login === 'unreadable') notes.push(`Claude Code could not be started or did not answer: ${authError}`)
  else if (login === 'unknown') notes.push('Claude Code account not reported yet.')
  else if (login === 'signed-out') {
    notes.push('Claude Code is not signed in, so HQ and connectors are unavailable. Double-click "Start Cortana.command" to sign in, or run npm run login.')
  } else if (login === 'other-provider') {
    notes.push('Claude Code is signed in with an API key or another provider, not your claude.ai account, so HQ and connectors are unavailable. Run npm run login and choose your Claude account.')
  }
  if (hqDb === 'expected') notes.push('HQ database expected; confirmed on the first question.')
  if (Array.isArray(initTools) && hqDb === 'unavailable' && !noHq) {
    notes.push('This Claude Code build did not offer ArtifactData; update Claude Code (`claude update`).')
  }
  if (needsAuth.length) notes.push(`Reconnect in claude.ai Settings > Connectors: ${needsAuth.join(', ')}.`)

  return {
    active,
    login,
    hqDb,
    hqTool,
    connectors: connectors.filter((n) => Object.hasOwn(READ_ALLOW, serviceOf(n) ?? '')),
    localMcp: localNames,
    account: account
      ? {
          email: account.email ?? null,
          subscription: account.subscriptionType ?? null,
          apiKeySource: account.apiKeySource ?? null,
        }
      : null,
    notes,
  }
}

/** One line for the bridge log and the HUD. */
export function describeDataPath(d) {
  const label = {
    'hq-db': `Donevia HQ database (${d.hqDb})`,
    connectors: 'claude.ai connectors',
    'local-mcp': 'MCP servers from ~/.claude.json',
    none: 'no data source',
  }[d.active]
  const extras = []
  if (d.active !== 'connectors' && d.connectors.length) extras.push(`connectors: ${d.connectors.join(', ')}`)
  if (d.active === 'connectors') extras.push(d.connectors.join(', '))
  if (d.active !== 'local-mcp' && d.localMcp.length) extras.push(`local MCP: ${d.localMcp.join(', ')}`)
  if (d.active === 'local-mcp') extras.push(d.localMcp.join(', '))
  return extras.length ? `${label} · ${extras.join(' · ')}` : label
}

/**
 * Servers from ~/.claude.json worth passing to the session: only ones whose
 * name maps to a service Jarvis can read. Everything else stays out of the
 * session so its tools never reach the model.
 */
export function pickLocalServers(config) {
  const out = {}
  for (const [name, def] of Object.entries(config ?? {})) {
    const svc = serviceOf(name)
    if (svc && KNOWN_SERVICES.has(svc) && !BLOCKED_SERVICES.has(svc)) out[name] = def
  }
  return out
}
