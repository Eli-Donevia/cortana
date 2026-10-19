/**
 * Donevia Jarvis — local bridge.
 *
 * Runs Claude Code headless through the Claude Agent SDK and exposes one
 * conversation per WebSocket to the face (the Vite app in Chrome). The face is
 * the microphone, the voice and the screen; this process is the brain.
 *
 *   - It signs in the way `claude` does, with Eli's claude.ai login. No API key.
 *   - It reads the Donevia HQ database (ArtifactData) and the claude.ai
 *     connectors, read-only. Its one write is a command to commands/{id}.
 *   - Every tool call passes the gate in policy.mjs, in a PreToolUse hook and
 *     again in canUseTool. There is no writes mode.
 *   - It listens on 127.0.0.1 only, checks Host and Origin on every request,
 *     and needs the per-launch token from `npm start` (see access.mjs). One
 *     window at a time.
 *   - Questions that Claude Code would run as slash commands are refused
 *     before they reach it (see ask.mjs).
 *
 * Forked from adewaskar/jarvis (MIT). The turn plumbing (streaming, interrupts,
 * ask ids) is upstream's; the data path, the gate and the persona are new.
 *
 *   node bridge/server.mjs
 */

import { mkdirSync } from 'node:fs'
import { createServer } from 'node:http'
import { WebSocketServer } from 'ws'
import { query } from '@anthropic-ai/claude-agent-sdk'
import { displayServer } from './panels.mjs'
import { uiServer } from './ui.mjs'
import { buildSystemPrompt } from './persona.mjs'
import { classifyDataPath, describeDataPath } from './datapath.mjs'
import { artifactId, decideTool, denyMessage, makePreToolUseHook } from './policy.mjs'
import { createConfirmations, isClearYes } from './confirm.mjs'
import {
  DEFAULT_FILE as WORKSPACES_DEFAULT,
  acrossAll,
  addWorkspace,
  findWorkspace,
  loadWorkspaces,
  saveWorkspaces,
  workspaceCommand,
} from './workspaces.mjs'
import { filesServer } from './files.mjs'
import { agentCommand, createAgentManager, describeTask } from './agents.mjs'
import { createRunner } from './agentRunner.mjs'
import { readLocalServers, inspect, sessionOptions, probeDataPath } from './probe.mjs'
import { config, childEnv, settingsProblems, settingsFiles } from './env.mjs'
import { checkAsk } from './ask.mjs'
import {
  PROTOCOL,
  TOKEN_HEADER,
  faceOrigins,
  hostAllowed,
  newToken,
  originAllowed as originIn,
  tokenFromProtocols,
  tokenMatches,
} from './access.mjs'

const VERSION = '1.0.0'
const { port: PORT, hqUrl: HQ_URL, model: MODEL, effort: EFFORT } = config

process.on('unhandledRejection', (err) => {
  console.error('[jarvis] unhandled rejection:', err)
})

if (process.env.JARVIS_ALLOW_WRITES) {
  console.warn('[jarvis] JARVIS_ALLOW_WRITES is ignored: Donevia Jarvis has no writes mode.')
}

// ---------------------------------------------------------------------------
// Access
// ---------------------------------------------------------------------------

/**
 * Only the face's own origin, on the loopback Host, with this launch's token.
 * `npm start` passes the token in JARVIS_TOKEN; started on its own, the bridge
 * makes one and prints the link to open.
 */
const ORIGINS = faceOrigins({ extra: config.extraOrigins })
const originAllowed = (origin) => originIn(origin, ORIGINS, { allowNoOrigin: config.allowNoOrigin })

const TOKEN = /^[a-f0-9]{32,64}$/.test(process.env.JARVIS_TOKEN ?? '') ? process.env.JARVIS_TOKEN : newToken()
const tokenFromEnv = TOKEN === process.env.JARVIS_TOKEN
delete process.env.JARVIS_TOKEN

// ---------------------------------------------------------------------------
// Data sources
// ---------------------------------------------------------------------------

const LOCAL_SERVERS = readLocalServers()

mkdirSync(config.workDir, { recursive: true })

const { env: CHILD_ENV, removed: REMOVED_ENV } = childEnv()

/** Eli's companies (bridge/workspaces.mjs). One is active; each gets its own conversation. */
const WORKSPACES_FILE = process.env.JARVIS_WORKSPACES_FILE || WORKSPACES_DEFAULT
let WS = loadWorkspaces(WORKSPACES_FILE)
console.log(`[jarvis] workspaces: ${WS.workspaces.map((w) => w.name).join(', ')} (active: ${WS.active}) from ${WORKSPACES_FILE}`)

/** The latest view of the data path; refined by every session. */
let dataPath = classifyDataPath({ localServers: Object.keys(LOCAL_SERVERS) })
const pathListeners = new Set()

function setDataPath(next, why) {
  const before = describeDataPath(dataPath)
  dataPath = next
  const after = describeDataPath(dataPath)
  if (after !== before || why === 'boot') {
    console.log(`[jarvis] data path (${why}): ${after}`)
    for (const n of dataPath.notes) console.log(`[jarvis]   note: ${n}`)
  }
  for (const fn of pathListeners) fn(dataPath)
}

/** Options shared by the boot probe and every conversation. */
const baseOptions = () => sessionOptions(CHILD_ENV)

// ---------------------------------------------------------------------------
// Agents (bridge/agents.mjs): background tasks Cortana sends out
// ---------------------------------------------------------------------------

const runner = createRunner({ localServers: LOCAL_SERVERS, baseOptions })

/** What the face's Agents panel shows for one task. */
const agentView = (t) => ({
  id: t.id,
  brief: t.brief,
  status: t.status,
  note: t.notes[t.notes.length - 1] ?? '',
  proposals: t.proposals.map(({ pid, summary, status, result }) => ({ pid, summary, status, result: result ?? '' })),
  report: t.report,
  error: t.error,
  createdAt: t.createdAt,
})

const agents = createAgentManager({
  workspaces: () => WS.workspaces,
  hqUrl: HQ_URL,
  runAgent: runner.runAgent,
  execute: runner.execute,
  onEvent: ({ type, task }) => {
    sendAgents()
    if (type === 'change') return
    const what = task.brief.length > 60 ? `${task.brief.slice(0, 59)}…` : task.brief
    const line =
      type === 'done'
        ? `Your agent is done with ${what}. Say "show me what it found".`
        : type === 'needs-approval'
          ? `Your agent finished ${what} and wants your OK on ${task.proposals.filter((p) => p.status === 'pending').length === 1 ? 'one action' : 'some actions'}: ${task.proposals.find((p) => p.status === 'pending')?.summary}. Say "approve it" or "deny it".`
          : `Your agent stopped on ${what}: ${task.error}.`
    console.log(`[jarvis] agent ${task.id} ${type}: ${task.brief.slice(0, 60)}`)
    if (task.workspace === WS.active) faceSend({ type: 'agent-event', kind: type, id: task.id, line })
  },
})
console.log(`[jarvis] agents: ${agents.load()} saved task(s) loaded`)

/** Send to the one live window, if any. */
function faceSend(msg) {
  if (current && current.readyState === current.OPEN) current.send(JSON.stringify(msg))
}
function sendAgents() {
  faceSend({ type: 'agents', list: agents.list(WS.active).slice(0, 20).map(agentView) })
}

/** One probe at boot so the log says which data path is live before anyone speaks. */
async function bootProbe() {
  setDataPath(await probeDataPath({ options: baseOptions(), localServers: LOCAL_SERVERS }), 'boot')
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

/** What the face reads at boot. Runtime settings, never secrets of Eli's accounts. */
function publicConfig() {
  return {
    version: VERSION,
    hqUrl: HQ_URL,
    tts: { engine: config.ttsEngine, voice: config.kokoroVoice, device: config.kokoroDevice },
    wake: {
      mode: config.wake,
      // The Picovoice AccessKey is Eli's own, set in his settings file. It is handed
      // to the page because Porcupine runs in the browser; it never leaves
      // localhost except to Picovoice's licence check.
      porcupineKey: config.picovoiceKey || null,
    },
  }
}

function health() {
  return {
    ok: true,
    version: VERSION,
    model: MODEL,
    effort: EFFORT,
    dataPath: { ...dataPath, summary: describeDataPath(dataPath) },
    removedEnv: REMOVED_ENV,
  }
}

const handleRequest = async (req, res) => {
  if (!hostAllowed(req.headers.host, PORT)) {
    console.warn(`[jarvis] refused http request for host ${req.headers.host ?? '(none)'}`)
    res.writeHead(403)
    return res.end('forbidden')
  }
  const origin = req.headers.origin
  if (origin && !originAllowed(origin)) {
    console.warn(`[jarvis] refused http request from origin ${origin}`)
    res.writeHead(403, { vary: 'origin' })
    return res.end('forbidden')
  }
  const cors = { vary: 'origin' }
  if (origin) {
    cors['access-control-allow-origin'] = origin
    cors['access-control-allow-headers'] = `content-type, ${TOKEN_HEADER}`
  }
  if (req.method === 'OPTIONS') {
    res.writeHead(204, cors)
    return res.end()
  }
  const json = (body, status = 200) => {
    res.writeHead(status, { ...cors, 'content-type': 'application/json', 'cache-control': 'no-store' })
    res.end(JSON.stringify(body))
  }
  const authed = tokenMatches(req.headers[TOKEN_HEADER], TOKEN)
  const path = (req.url ?? '/').split('?')[0]
  // Without the token, /health says only that this is Jarvis (setup and the
  // launcher use that); the account and data path need the token.
  if (req.method === 'GET' && path === '/health') return json(authed ? health() : { ok: true, app: 'donevia-jarvis', version: VERSION })
  if (req.method === 'GET' && path === '/config') {
    return authed ? json(publicConfig()) : json({ error: 'launch token required' }, 401)
  }
  res.writeHead(404, cors)
  res.end()
}

const server = createServer((req, res) => {
  handleRequest(req, res).catch((err) => {
    console.error('[jarvis] request failed:', err)
    if (!res.headersSent) res.writeHead(500)
    res.end()
  })
})

const wss = new WebSocketServer({
  server,
  // The face offers ["donevia-jarvis", "jt.<token>"]; select the name, never
  // echo the token.
  handleProtocols: (protocols) => (protocols.has(PROTOCOL) ? PROTOCOL : false),
  verifyClient: ({ origin, req }, done) => {
    const p = (req.url ?? '/').split('?')[0]
    if (p !== '/' && p !== '/ws') return done(false, 403, 'Forbidden')
    if (!hostAllowed(req.headers.host, PORT)) {
      console.warn(`[jarvis] rejected websocket for host ${req.headers.host ?? '(none)'}`)
      return done(false, 403, 'Forbidden')
    }
    if (!originAllowed(origin)) {
      console.warn(`[jarvis] rejected websocket from origin ${origin ?? '(none)'}`)
      return done(false, 403, 'Forbidden')
    }
    if (!tokenMatches(tokenFromProtocols(req.headers['sec-websocket-protocol']), TOKEN)) {
      console.warn('[jarvis] rejected websocket without this launch\'s token (an old window, or not the Jarvis window)')
      return done(false, 401, 'Unauthorized')
    }
    done(true)
  },
})

// A port already taken is the common failure; say it in one line.
server.on('error', (err) => {
  if (err?.code === 'EADDRINUSE') {
    console.error(
      `[jarvis] Port ${PORT} is already in use by another program. Quit that program, ` +
        'or set JARVIS_BRIDGE_PORT in your settings (npm run settings), then start Jarvis again.',
    )
  } else {
    console.error(`[jarvis] The bridge could not start: ${err?.message ?? err}`)
  }
  process.exit(1)
})
wss.on('error', () => {
  /* the same error, reported once above */
})

// Loopback only. Upstream listened on every interface, which served files to
// anyone on the same network.
server.listen(PORT, '127.0.0.1', () => {
  console.log(`[jarvis] Cortana bridge ${VERSION} on ws://127.0.0.1:${PORT}`)
  console.log(`[jarvis] model ${MODEL} · effort ${EFFORT} · max ${config.maxTurns} tool turns`)
  console.log('[jarvis] reads: HQ + connectors, per workspace. Actions: only after Eli says yes (email drafts only, never send). Agents: up to 4, actions held for approval.')
  console.log(`[jarvis] HQ ${HQ_URL}`)
  if (!tokenFromEnv) {
    console.log('[jarvis] started without `npm start`, so it made its own launch token. Open the face at:')
    console.log(`[jarvis]   http://127.0.0.1:5173/#t=${TOKEN}`)
  }
  if (REMOVED_ENV.length) {
    console.log(`[jarvis] ignoring ${REMOVED_ENV.join(', ')} so Claude Code uses your claude.ai login`)
  }
  if (Object.keys(LOCAL_SERVERS).length) {
    console.log(`[jarvis] local MCP servers passed through: ${Object.keys(LOCAL_SERVERS).join(', ')}`)
  }
  if (settingsFiles.length) console.log(`[jarvis] settings from ${settingsFiles.map((f) => `"${f}"`).join(' and ')}`)
  for (const p of settingsProblems) console.warn(`[jarvis] ${p}`)
  console.log('[jarvis] transcripts: not saved (persistSession off)')
  if (process.env.JARVIS_SKIP_PROBE === '1') {
    console.log('[jarvis] boot probe skipped (JARVIS_SKIP_PROBE=1)')
  } else {
    void bootProbe()
  }
})

// ---------------------------------------------------------------------------
// Conversations
// ---------------------------------------------------------------------------

const RESULT_FAILURES = {
  error_during_execution: 'The turn failed part way through.',
  error_max_turns: 'That took too many steps, so I stopped.',
  error_max_budget_usd: 'The budget for this turn ran out.',
  error_max_structured_output_retries: 'The answer could not be assembled.',
  default: 'The turn ended without an answer.',
}

/** Display tools are the face drawing itself, not work worth a badge. */
const isFaceTool = (name) => name.startsWith('mcp__jarvis__') || name.startsWith('mcp__jarvis_ui__')

const logDecision = (name, verdict, where) => {
  if (verdict.allow && !config.debug) return
  console.log(`[jarvis] ${where} ${name} -> ${verdict.allow ? 'allow' : 'deny'} (${verdict.reason})`)
}

/** The one live window. A new one replaces it (close code 4001). */
let current = null

wss.on('connection', (socket) => {
  console.log('[jarvis] face connected')
  if (current && current.readyState === current.OPEN) {
    console.log('[jarvis] another window connected; closing the earlier one')
    current.close(4001, 'replaced')
  }
  current = socket

  let deliver = null
  let closed = false
  const inbox = []

  /** Questions for one session; `mine` is its generation, so an old one stops after a switch. */
  async function* userMessages(mine) {
    while (!closed && mine === gen) {
      const text =
        inbox.shift() ??
        (await new Promise((resolve) => {
          deliver = resolve
        }))
      if (closed || text == null) return
      if (mine !== gen) {
        // Arrived just as the workspace switched: it belongs to the new session.
        inbox.unshift(text)
        return
      }
      yield { type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null }
    }
  }

  const send = (msg) => {
    if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(msg))
  }

  /** Which question is being answered, echoed so the face can drop stale frames. */
  let answering = null
  const sendTurn = (msg) => send({ ...msg, ask: answering })

  const sendPath = (p) => send({ type: 'datapath', path: { ...p, summary: describeDataPath(p) } })
  pathListeners.add(sendPath)
  sendPath(dataPath)
  send({ type: 'ready', servers: serverLabels(dataPath) })

  let settling = Promise.resolve()
  let finishTurn = null
  const turnFinished = () =>
    new Promise((resolve) => {
      finishTurn = resolve
    })
  const SETTLE_CAP_MS = 400

  /**
   * Tool badges are announced from the PreToolUse hook: it is the one place
   * that sees the input and runs only for calls about to execute.
   */
  const announced = new Set()
  /** Command ids hq_command handed out in this conversation; the only ones that may be written. */
  // Command id -> the exact text hq_command issued with it.
  const issued = new Map()
  // Actions wait for Eli's spoken yes; this holds them (bridge/confirm.mjs).
  const confirm = createConfirmations()
  const opts = { hqUrl: HQ_URL, issued, confirm }
  /** Remember HQ docs as they are read, so a write can be checked against them. */
  const postToolUse = async (input) => {
    const name = input?.tool_name
    const ti = input?.tool_input ?? {}
    const op = name === 'Artifact' ? ti.db_op : name === 'ArtifactData' ? ti.action : null
    if (op === 'get' && artifactId(ti.url) === artifactId(opts.hqUrl)) {
      confirm.noteRead(ti.collection, ti.doc_id, JSON.stringify(input?.tool_response ?? ''))
    }
    return { continue: true }
  }
  const gate = makePreToolUseHook(opts, (name, verdict) => logDecision(name, verdict, 'hook'))
  const preToolUse = async (input, toolUseId, ctx) => {
    const out = await gate(input, toolUseId, ctx)
    const name = input?.tool_name
    if (out?.continue && name && !isFaceTool(name) && !announced.has(toolUseId)) {
      announced.add(toolUseId)
      sendTurn({ type: 'tool', name, detail: toolDetail(name, input?.tool_input) })
    }
    return out
  }

  // -- workspaces -----------------------------------------------------------
  const activeWs = () => WS.workspaces.find((w) => w.id === WS.active) ?? WS.workspaces[0]
  const applyWs = () => {
    const ws = activeWs()
    opts.workspace = ws
    opts.hqUrl = ws.hqUrl ?? HQ_URL
  }
  const sendWorkspaces = () =>
    send({ type: 'workspaces', active: activeWs().id, list: WS.workspaces.map(({ id, name, accent }) => ({ id, name, accent })) })
  applyWs()
  sendWorkspaces()
  sendAgents()

  let session = null
  let gen = 0

  /** One conversation, for the active workspace. A switch starts a new one. */
  function startSession() {
    const mine = ++gen
    const ws = activeWs()
    const s = query({
      prompt: userMessages(mine),
      options: {
        ...baseOptions(),
        mcpServers: {
          ...LOCAL_SERVERS,
          jarvis: displayServer({
            emitBlade: (blade) => send({ type: 'blade', blade }),
            hqUrl: opts.hqUrl,
            hqTool: () => dataPath.hqTool ?? 'ArtifactData',
            onIssue: (id, text) => issued.set(id, text),
          }),
          jarvis_ui: uiServer((op, args) => send({ type: 'ui', op, args })),
          jarvis_files: filesServer(ws.filesDir),
        },
        systemPrompt: buildSystemPrompt({
          path: dataPath,
          hqUrl: ws.hqUrl,
          workspace: ws,
          others: WS.workspaces.filter((w) => w.id !== ws.id).map((w) => w.name),
        }),
        includePartialMessages: true,
        hooks: { PreToolUse: [{ hooks: [preToolUse] }], PostToolUse: [{ hooks: [postToolUse] }] },
        // The second gate. The hook already denied anything outside the policy;
        // this sees whatever the CLI asks about and applies the same rule.
        canUseTool: async (toolName, input) => {
          const verdict = decideTool(toolName, input, { ...opts, stage: 'final' })
          logDecision(toolName, verdict, 'gate')
          return verdict.allow
            ? { behavior: 'allow', updatedInput: input }
            : { behavior: 'deny', message: denyMessage(verdict.reason) }
        },
      },
    })

    session = s

    // Refine the data path for this session without spending a turn.
    void inspect(s).then((facts) => {
      if (closed) return
      setDataPath(classifyDataPath({ ...facts, localServers: Object.keys(LOCAL_SERVERS) }), 'session')
    })

    ;(async () => {
      try {
        for await (const msg of s) {
          if (mine !== gen) break
          if (config.debug) console.log('[msg]', msg.type, msg.subtype ?? msg.event?.type ?? '')
          switch (msg.type) {
            case 'stream_event': {
              const ev = msg.event
              if (ev?.type === 'content_block_delta' && ev.delta?.type === 'text_delta' && ev.delta.text) {
                sendTurn({ type: 'text', delta: ev.delta.text })
              }
              break
            }
            case 'result':
              if (msg.subtype === 'success') {
                sendTurn({ type: 'done', text: msg.result ?? '', costUsd: msg.total_cost_usd ?? null })
              } else {
                console.error(`[jarvis] turn failed: ${msg.subtype}`, msg.errors ?? '')
                sendTurn({ type: 'error', message: RESULT_FAILURES[msg.subtype] ?? RESULT_FAILURES.default })
              }
              finishTurn?.()
              finishTurn = null
              announced.clear()
              break
            case 'system':
              if (msg.subtype === 'init') {
                // The first turn tells us for certain which tools exist.
                if (msg.apiKeySource && msg.apiKeySource !== 'none') {
                  console.warn(`[jarvis] Claude Code is using an API key (${msg.apiKeySource}), not your claude.ai login.`)
                }
                const tools = msg.tools ?? []
                const servers = msg.mcp_servers ?? null
                // Not awaited: the answer's first words are already on their way.
                void inspect(s, tools).then((fresh) => {
                  setDataPath(
                    classifyDataPath({
                      ...fresh,
                      mcpStatus: fresh.mcpStatus ?? servers,
                      localServers: Object.keys(LOCAL_SERVERS),
                    }),
                    'first turn',
                  )
                  send({ type: 'ready', servers: serverLabels(dataPath) })
                })
              }
              break
          }
        }
      } catch (err) {
        if (mine !== gen) return // the session a switch closed
        console.error('[jarvis] session error:', err)
        send({ type: 'error', message: friendlyError(err) })
        closed = true
        deliver?.(null)
        s.close?.()
        socket.close()
      }
    })()
  }
  startSession()

  function switchTo(id) {
    WS = { ...WS, active: id }
    try {
      saveWorkspaces(WS, WORKSPACES_FILE)
    } catch (err) {
      console.warn(`[jarvis] could not save ${WORKSPACES_FILE}: ${err.message}`)
    }
    applyWs()
    confirm.onUserText('') // pending actions belong to the old workspace: cancelled
    const old = session
    deliver = null
    startSession()
    old?.close?.()
    sendWorkspaces()
    sendAgents()
    console.log(`[jarvis] workspace: ${activeWs().name}`)
  }

  /** Spoken line for a question the bridge answered itself. */
  const reply = (id, line) => {
    send({ type: 'text', delta: line, ask: id })
    send({ type: 'done', text: line, costUsd: 0, ask: id })
  }

  /** Agent commands: send, status, cancel, report, approve, deny. */
  function handleAgentAsk(text, id) {
    const cmd = agentCommand(text)
    if (!cmd) return false
    const mine = agents.list(WS.active)
    if (cmd.type === 'dispatch') {
      if (!cmd.brief) return false
      agents.dispatch(cmd.brief, WS.active)
      reply(id, `On it. I've sent an agent to ${cmd.brief}, in ${activeWs().name}. I'll tell you when it's done.`)
    } else if (cmd.type === 'status') {
      const recent = mine.filter((t) => t.status !== 'cancelled').slice(0, 4)
      reply(id, recent.length ? `${recent.length === 1 ? 'One agent' : `${recent.length} agents`}: ${recent.map(describeTask).join('. ')}.` : 'No agents out in this workspace.')
    } else if (cmd.type === 'cancel' || cmd.type === 'cancel-all') {
      const live = mine.filter((t) => t.status === 'queued' || t.status === 'working')
      const targets = cmd.type === 'cancel' ? live.slice(0, 1) : live
      for (const t of targets) agents.cancel(t.id)
      reply(id, targets.length ? `Cancelled ${targets.length === 1 ? `the agent on ${targets[0].brief}` : `${targets.length} agents`}.` : 'No agent is running right now.')
    } else if (cmd.type === 'report') {
      const t = mine.find((x) => x.report)
      if (!t) reply(id, 'No agent has reported back yet.')
      else {
        const esc = (x) => String(x).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c])
        send({
          type: 'blade',
          blade: {
            id: `agent-${t.id}`,
            title: 'AGENT REPORT',
            kind: 'markup',
            html: `<p class="hud-label">${esc(t.brief)}</p>${t.report.split(/\n{2,}/).map((para) => `<p>${esc(para)}</p>`).join('')}`,
            accent: 'default',
            size: 'wide',
            hold: 'sticky',
          },
        })
        reply(id, `Here's what it found on ${t.brief}. ${t.report.split(/(?<=[.!?])\s/)[0]}`)
      }
    } else if (cmd.type === 'approve' || cmd.type === 'deny') {
      const t = mine.find((x) => x.proposals.some((p) => p.status === 'pending'))
      const p = t?.proposals.find((x) => x.status === 'pending')
      if (!t || !p) return false // nothing waiting: let Cortana's own confirmation handle it
      if (cmd.type === 'deny') {
        void agents.decide(t.id, p.pid, false)
        reply(id, `Okay, I won't do that: ${p.summary}.`)
      } else {
        console.log(`[jarvis] Eli approved agent action: ${p.summary}`)
        reply(id, `Approved. Doing it now: ${p.summary}.`)
        void agents.decide(t.id, p.pid, true)
      }
    }
    return true
  }

  let pendingAdd = null
  /** "Switch to X", "which workspace", "list my workspaces", "add a workspace called X". */
  function handleWorkspaceAsk(text, id) {
    if (pendingAdd) {
      const name = pendingAdd
      pendingAdd = null
      if (isClearYes(text)) {
        const r = addWorkspace(WS, name)
        if (!r.added) {
          reply(id, r.why)
          return true
        }
        WS = r.data
        try {
          saveWorkspaces(WS, WORKSPACES_FILE)
          mkdirSync(r.added.filesDir, { recursive: true })
        } catch (err) {
          console.warn(`[jarvis] could not save the new workspace: ${err.message}`)
        }
        sendWorkspaces()
        reply(id, `Done. ${r.added.name} is set up, with its own folder in Documents. Say "switch to ${r.added.name}" to use it.`)
        return true
      }
    }
    const cmd = workspaceCommand(text)
    if (!cmd) return false
    // "Move to the next item" parses like a switch; it only is one if the name is a workspace.
    if (cmd.type === 'switch' && !findWorkspace(WS.workspaces, cmd.name)) return false
    const names = WS.workspaces.map((w) => w.name).join(', ')
    if (cmd.type === 'which') reply(id, `You're in ${activeWs().name}.`)
    else if (cmd.type === 'list') reply(id, `Your workspaces are ${names}. You're in ${activeWs().name}.`)
    else if (cmd.type === 'add') {
      pendingAdd = cmd.name
      reply(id, `Add a new workspace called ${cmd.name}, with its own folder in Documents. Shall I?`)
    } else if (cmd.type === 'switch') {
      const w = findWorkspace(WS.workspaces, cmd.name)
      if (!w) reply(id, `I don't have a workspace called ${cmd.name}. You have ${names}.`)
      else if (w.id === WS.active) reply(id, `You're already in ${w.name}.`)
      else {
        switchTo(w.id)
        reply(id, `Switched to ${w.name}. Fresh start, ${w.name} only.`)
      }
    }
    return true
  }

  socket.on('message', (raw) => {
    let msg
    try {
      msg = JSON.parse(raw.toString())
    } catch {
      return
    }
    if (msg.type === 'ask' && typeof msg.text === 'string') {
      const id = typeof msg.id === 'string' ? msg.id.slice(0, 40) : null
      // Slash commands, "!" and @file mentions never reach Claude Code: they
      // would run without a tool call, so the policy gate would not see them.
      const checked = checkAsk(msg.text)
      if (!checked.ok) {
        console.warn(`[jarvis] ${checked.reason}`)
        if (checked.say) send({ type: 'text', delta: checked.say, ask: id })
        send({ type: 'done', text: checked.say, costUsd: 0, ask: id })
        return
      }
      const text = checked.text
      if (handleWorkspaceAsk(text, id)) return
      if (handleAgentAsk(text, id)) return
      // "Across all companies" opens every workspace's sources for this one question.
      opts.acrossAll = acrossAll(text)
      // Eli's own words are the only thing that can approve an action.
      const said = confirm.onUserText(text)
      if (said.approved.length) console.log(`[jarvis] Eli confirmed: ${said.approved.join(' | ')}`)
      if (said.cancelled.length) console.log(`[jarvis] cancelled, no clear yes: ${said.cancelled.length} action(s)`)
      // Queued behind any interrupt still settling, so the tail of an
      // abandoned answer never lands on the new question.
      void settling.then(() => {
        answering = id
        if (deliver) {
          const resolve = deliver
          deliver = null
          resolve(text)
        } else {
          inbox.push(text)
        }
      })
    }
    // The Agents panel: Approve / Deny a proposed action, or cancel a task.
    if (msg.type === 'agent-decide' && typeof msg.id === 'string' && typeof msg.pid === 'string') {
      const t = agents.get(msg.id)
      if (t && t.workspace === WS.active) {
        console.log(`[jarvis] Eli ${msg.approve === true ? 'approved' : 'denied'} agent action ${msg.id}/${msg.pid} in the panel`)
        void agents.decide(msg.id, msg.pid, msg.approve === true)
      }
    }
    if (msg.type === 'agent-cancel' && typeof msg.id === 'string') {
      const t = agents.get(msg.id)
      if (t && t.workspace === WS.active) agents.cancel(msg.id)
    }
    if (msg.type === 'workspace' && typeof msg.id === 'string') {
      // The switcher in the face.
      if (msg.id !== WS.active && WS.workspaces.some((w) => w.id === msg.id)) switchTo(msg.id)
      else sendWorkspaces()
    }
    if (msg.type === 'interrupt') {
      const stopped = turnFinished()
      settling = Promise.resolve(session.interrupt?.())
        .catch(() => {})
        .then(() => Promise.race([stopped, new Promise((r) => setTimeout(r, SETTLE_CAP_MS))]))
    }
  })

  socket.on('close', () => {
    console.log('[jarvis] face disconnected')
    if (current === socket) current = null
    pathListeners.delete(sendPath)
    closed = true
    deliver?.(null)
    session.close?.()
  })
})

/** The SYSTEMS rail: HQ first, then the connectors Jarvis may read. */
function serverLabels(p) {
  const out = []
  if (p.hqDb !== 'unavailable') out.push(p.hqDb === 'confirmed' ? 'Donevia HQ' : 'Donevia HQ (expected)')
  out.push(...p.connectors)
  out.push(...p.localMcp)
  return out
}

/** A short badge for the HUD, e.g. "HQ · pipeline" or "Gmail · search threads". */
function toolDetail(name, input) {
  if (name === 'Agent') return 'Thinking deeper'
  if (name === 'ArtifactData' || name === 'Artifact') {
    const op = input?.db_op ?? input?.action
    const c = input?.collection ?? (op === 'batch' ? 'commands' : '')
    return op === 'set' || op === 'update' || op === 'batch' ? 'HQ · command' : `HQ · ${c}`
  }
  const m = /^mcp__(?:claude_ai_)?([^_].*?)__(.+)$/.exec(name)
  if (m) return `${m[1].replace(/_/g, ' ')} · ${m[2].replace(/[_-]/g, ' ')}`
  return name
}

/** Spoken errors: plain, no stack traces, a next step where there is one. */
function friendlyError(err) {
  const s = String(err?.message ?? err)
  if (/login|auth|401|credential|not logged/i.test(s)) {
    return 'Claude Code is not signed in. Close me, then double-click the Start Cortana file; it will help you sign in.'
  }
  if (/ENOENT|spawn|executable/i.test(s)) {
    return 'Claude Code could not be started. Run npm run setup to see what is missing.'
  }
  return 'The connection to Claude Code dropped. I will reconnect.'
}
