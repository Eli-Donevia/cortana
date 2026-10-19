import type { Blade, DataPath } from '../store'
import { BRIDGE_WS_URL } from '../config'
import { bridgeProtocols, launchToken, NO_TOKEN_MESSAGE } from './token'

export type AskHandlers = {
  /** A piece of the spoken answer, as it streams. */
  onText: (delta: string) => void
  /** A tool started; `label` is a short readable badge like "HQ · pipeline". */
  onTool: (label: string, raw: string) => void
}

/**
 * Client for the local bridge (see bridge/server.mjs).
 *
 * Donevia Jarvis has one brain: the bridge, running Claude Code on this Mac.
 * (Upstream's browser-direct path, which needed an API key in the bundle, is
 * gone.)
 *
 * The socket is the session. The bridge holds one Claude Agent SDK query per
 * connection and the whole conversation lives inside it, so a dropped socket
 * silently wipes JARVIS's memory of the exchange while the transcript on screen
 * still shows it. That is why the reconnect below is loud rather than
 * invisible: `watchConnection` exists so the HUD can say so.
 */

/** Anything the bridge sends. Deliberately loose — a frame from a future
 *  bridge build should be ignored, not crash the turn. */
type Frame = {
  type?: string
  delta?: string
  name?: string
  text?: string
  message?: string
  detail?: string
  path?: DataPath
  blade?: Blade
  op?: string
  args?: unknown
  id?: string
  ask?: string
  reason?: string
  mode?: string
  seconds?: number
  when?: string
  servers?: Array<string | { name?: string }>
}

/** Every question gets an id so its answer can be told from anyone else's. */
let askSeq = 0

let socket: WebSocket | null = null
let connecting: Promise<WebSocket> | null = null

/** Server names reported by the bridge, for the HUD readout. */
let servers: string[] = []
export const bridgeServers = () => servers

/** The list arrives twice — once from config, once with live status — so the
 *  HUD subscribes rather than reading it a single time at boot. */
let onServers: ((s: string[]) => void) | null = null
export function watchServers(fn: (s: string[]) => void) {
  onServers = fn
}

/** Which data source the bridge is using, pushed on connect and on change. */
let dataPath: DataPath | null = null
export const currentDataPath = () => dataPath
let onDataPath: ((p: DataPath) => void) | null = null
export function watchDataPath(fn: (p: DataPath) => void) {
  onDataPath = fn
  if (dataPath) fn(dataPath)
}

/** Blades arrive the same way panels do — pushed mid-turn, so the article is
 *  already open as he starts the sentence about it. */
let onBlade: ((blade: Blade) => void) | null = null
export function watchBlades(fn: (blade: Blade) => void) {
  onBlade = fn
}

/** Commands that redress the interface — theme, reactor, effects. Same
 *  out-of-band route as panels: JARVIS issues them while he is still mid-answer
 *  so the change is on screen as he says it, which means they cannot ride back
 *  on the turn's result. The op/args pair stays untyped here on purpose — this
 *  module is a transport, and the store is where the shape is decided. */
let onUi: ((op: string, args: any) => void) | null = null
export function watchUi(fn: (op: string, args: any) => void) {
  onUi = fn
}

/**
 * Connection state, for the UI.
 *
 *   'open'        — first connection of the page.
 *   'lost'        — the socket died. The agent session died with it, so
 *                   everything said so far is gone as far as JARVIS knows.
 *   'reconnected' — we're back, on a fresh session with no memory of the above.
 *   'replaced'    — another Jarvis window took over (the bridge allows one).
 *                   No automatic re-dial, or two windows would fight; the next
 *                   question here takes it back.
 */
export type ConnectionState = 'open' | 'lost' | 'reconnected' | 'replaced'
let onConnection: ((state: ConnectionState) => void) | null = null
export function watchConnection(fn: (state: ConnectionState) => void) {
  onConnection = fn
}

/** Eli's workspaces (one per company) and which one is active, pushed by the bridge. */
export type Workspace = { id: string; name: string; accent: string }
let workspaces: { active: string; list: Workspace[] } = { active: '', list: [] }
export const currentWorkspaces = () => workspaces
let onWorkspaces: ((w: { active: string; list: Workspace[] }) => void) | null = null
export function watchWorkspaces(fn: (w: { active: string; list: Workspace[] }) => void): () => void {
  onWorkspaces = fn
  if (workspaces.list.length) fn(workspaces)
  return () => {
    if (onWorkspaces === fn) onWorkspaces = null
  }
}

/** Switch workspace from the switcher. The bridge starts a fresh conversation for it. */
export function switchWorkspace(id: string): void {
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'workspace', id }))
}

/** Background agents (bridge/agents.mjs) for the active workspace. */
export type AgentProposal = { pid: string; summary: string; status: string; result: string }
export type AgentTask = {
  id: string
  brief: string
  status: 'queued' | 'working' | 'needs-approval' | 'done' | 'failed' | 'cancelled'
  note: string
  proposals: AgentProposal[]
  report: string
  error: string
  createdAt: string
}
let agentList: AgentTask[] = []
let onAgents: ((list: AgentTask[]) => void) | null = null
export function watchAgents(fn: (list: AgentTask[]) => void): () => void {
  onAgents = fn
  fn(agentList)
  return () => {
    if (onAgents === fn) onAgents = null
  }
}
/** A one-line heads-up from the bridge: an agent finished, needs approval, or stopped. */
type Notice = { kind: string; id: string; line: string; speak: boolean }
let onAgentEvent: ((e: Notice) => void) | null = null
export function watchAgentEvents(fn: (e: Notice) => void) {
  onAgentEvent = fn
}
export function decideAgentAction(id: string, pid: string, approve: boolean): void {
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'agent-decide', id, pid, approve }))
}
export function cancelAgent(id: string): void {
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'agent-cancel', id }))
}

export function isConnected(): boolean {
  return socket?.readyState === WebSocket.OPEN
}

// ---------------------------------------------------------------------------
// Connection
// ---------------------------------------------------------------------------

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

/** Resolved by the socket-level dispatcher on the first `ready` of the current
 *  connection. Re-armed per connection so a reconnect re-announces. */
let firstReady = deferred()

let everConnected = false

/** Backoff for the automatic re-dial. It gives up after the last delay rather
 *  than retrying forever — a bridge that has been down for half a minute is
 *  usually one you stopped on purpose, and the next ask() re-dials anyway. */
const RECONNECT_DELAYS = [500, 1000, 2000, 4000, 8000, 8000]
let attempt = 0
let reconnectTimer = 0

function scheduleReconnect() {
  if (attempt >= RECONNECT_DELAYS.length) return
  const delay = RECONNECT_DELAYS[attempt]
  attempt += 1
  clearTimeout(reconnectTimer)
  reconnectTimer = window.setTimeout(() => {
    void connect().catch(() => {})
  }, delay)
}

/**
 * One message listener per socket, owning everything that isn't part of a
 * turn. It used to live inside warmBridge, bound to that one socket: after any
 * reconnect the SYSTEM rail froze for the life of the page, and every extra
 * warmBridge() call leaked another listener onto the same socket.
 */
function dispatch(ws: WebSocket) {
  ws.addEventListener('message', (e: MessageEvent) => {
    let msg: Frame
    try {
      msg = JSON.parse(e.data as string)
    } catch {
      return
    }

    if (msg.type === 'ready') {
      // The bridge announces immediately on connect from Claude Code's config,
      // then again with live status once the agent initialises. Keep listening
      // so the later, more accurate list wins.
      servers = (msg.servers ?? [])
        .map((s) => (typeof s === 'string' ? s : (s.name ?? '')))
        .filter(Boolean)
      onServers?.(servers)
      firstReady.resolve()
    } else if (msg.type === 'datapath' && msg.path) {
      dataPath = msg.path
      onDataPath?.(msg.path)
    } else if (msg.type === 'blade' && msg.blade) {
      onBlade?.(msg.blade)
    } else if (msg.type === 'agents') {
      const m = msg as unknown as { list?: AgentTask[] }
      agentList = Array.isArray(m.list) ? m.list : []
      onAgents?.(agentList)
    } else if (msg.type === 'agent-event') {
      const m = msg as unknown as { kind?: string; id?: string; line?: string; speak?: boolean }
      if (m.line) onAgentEvent?.({ kind: String(m.kind ?? ''), id: String(m.id ?? ''), line: String(m.line), speak: m.speak !== false })
    } else if (msg.type === 'workspaces') {
      const m = msg as unknown as { active?: string; list?: Workspace[] }
      workspaces = { active: String(m.active ?? ''), list: Array.isArray(m.list) ? m.list : [] }
      onWorkspaces?.(workspaces)
    } else if (msg.type === 'ui' && msg.op) {
      // A `ui` frame with no args is normal — reset and clear take none — so an
      // absent args object is an empty one, not a reason to drop the command.
      onUi?.(msg.op, (msg.args ?? {}) as Record<string, unknown>)
    }
  })
}

function connect(): Promise<WebSocket> {
  if (socket?.readyState === WebSocket.OPEN) return Promise.resolve(socket)
  if (connecting) return connecting

  firstReady = deferred()

  const token = launchToken()
  if (!token) return Promise.reject(new Error(NO_TOKEN_MESSAGE))

  connecting = new Promise<WebSocket>((resolve, reject) => {
    const ws = new WebSocket(BRIDGE_WS_URL, bridgeProtocols(token))
    let settled = false

    /**
     * Every terminal path runs through here, and clearing `connecting` is the
     * whole point. The timeout used to reject without clearing it, which
     * bricked the client: the fast path above hands that same dead promise to
     * every later caller, so one slow start cost you a page reload.
     */
    const settle = (err: Error | null) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      connecting = null
      if (err) reject(err)
      else resolve(ws)
    }

    const timer = setTimeout(() => {
      ws.close()
      settle(new Error('The bridge is not responding. Is `npm start` running?'))
    }, 6000)

    ws.onopen = () => {
      socket = ws
      attempt = 0
      dispatch(ws)
      settle(null)
      onConnection?.(everConnected ? 'reconnected' : 'open')
      everConnected = true
    }
    ws.onerror = () => {
      /**
       * The browser will not say why. A bridge that is not running, a stale
       * launch token (Jarvis was restarted but this window was not) and a page
       * on the wrong address all look the same here, so name all three.
       */
      settle(
        new Error(
          `Cannot reach the bridge at ${BRIDGE_WS_URL}. Either Cortana is not running ` +
            '(double-click "Start Cortana.command"), or this window is from an ' +
            'earlier start: close it and start Cortana again. The bridge only accepts ' +
            `the window it opened, on http://127.0.0.1:5173 (this page is on ${location.origin}).`,
        ),
      )
    }
    ws.onclose = (ev: CloseEvent) => {
      // A close before open is just a failed dial; after open it's a lost
      // session, and the two want different handling.
      settle(new Error('The bridge closed the connection.'))
      if (socket === ws) {
        socket = null
        if (ev.code === 4001) {
          // Another Jarvis window connected. Do not re-dial on our own.
          attempt = RECONNECT_DELAYS.length
          onConnection?.('replaced')
          return
        }
        onConnection?.('lost')
        scheduleReconnect()
      }
    }
  })

  return connecting
}

/** Open the socket early so the first "Hey Jarvis" isn't waiting on a handshake. */
export async function warmBridge(): Promise<void> {
  attempt = 0
  await connect()
  // Don't block startup if the bridge never announces — the dispatcher fills
  // the rail in whenever the list does turn up.
  await Promise.race([
    firstReady.promise,
    new Promise<void>((resolve) => setTimeout(resolve, 2500)),
  ])
}

// ---------------------------------------------------------------------------
// Turns
// ---------------------------------------------------------------------------

/**
 * No frame of any kind for two minutes means the turn is never coming back.
 * Generous on purpose: a long agent run can sit silent through a slow tool,
 * and cutting a real answer off is worse than waiting. What this catches is
 * the case that used to hang forever — the bridge alive but the turn lost.
 */
const IDLE_TIMEOUT_MS = 120_000

/** The turn in flight, so a barge-in can settle it locally. */
let pending: { finish: (fallback?: string) => void } | null = null

export async function ask(
  prompt: string,
  handlers: AskHandlers,
): Promise<{ text: string; tools: string[] }> {
  /**
   * A new question supersedes the one in flight.
   *
   * Two concurrent turns genuinely would corrupt each other — both listeners
   * see every delta, and the first 'done' resolves both with the other's text —
   * but refusing the new one was the wrong way to prevent that. It surfaced as
   * "JARVIS is already answering", which is a sentence about this module's
   * bookkeeping rather than about anything the user did, and it contradicts the
   * premise the whole app is built on: say something and it becomes the turn.
   *
   * It fired far more than it looked like it should, because the only thing
   * that cleared the slot was a barge-in — and a barge-in only fires in guard
   * mode. A transcript can arrive well after the speech that produced it: the
   * segment queue means several can be waiting, and their onsets happened while
   * the machine was still listening, when nothing interrupts. So the second
   * utterance of a normal sentence could land on a turn that was already
   * running and simply be refused.
   *
   * Cancelling settles the old promise synchronously, so by the time the code
   * below claims the slot there is nothing left to collide with. The abandoned
   * turn's caller sees its own `stale()` check and stands down quietly.
   */
  if (pending) cancel()

  // Claim the slot in this same tick. connect() below awaits, and two calls
  // made before it settles would otherwise both sail past the check above.
  let cancelledWhileDialling = false
  pending = {
    finish: () => {
      cancelledWhileDialling = true
    },
  }

  let ws: WebSocket
  try {
    ws = await connect()
  } catch (err) {
    pending = null
    throw err
  }

  // Barged in on before the socket was even up. Nothing was ever asked.
  if (cancelledWhileDialling) {
    pending = null
    return { text: '', tools: [] }
  }

  const id = `a${++askSeq}`
  const tools: string[] = []
  let text = ''

  return new Promise((resolve, reject) => {
    let done = false
    let timer = 0

    const cleanup = () => {
      done = true
      pending = null
      clearTimeout(timer)
      ws.removeEventListener('message', onMessage)
      ws.removeEventListener('close', onClose)
      ws.removeEventListener('error', onError)
    }

    const finish = (fallback = '') => {
      if (done) return
      cleanup()
      // Prefer the streamed text; fall back to the final result if this build
      // didn't emit deltas.
      resolve({ text: (text || fallback).trim(), tools })
    }

    const fail = (err: Error) => {
      if (done) return
      cleanup()
      reject(err)
    }

    const arm = () => {
      clearTimeout(timer)
      timer = window.setTimeout(() => {
        fail(new Error('The bridge went quiet, so that question was lost.'))
      }, IDLE_TIMEOUT_MS)
    }

    const onMessage = (e: MessageEvent) => {
      // Any frame at all is proof of life, including ones this turn ignores.
      arm()

      let msg: Frame
      try {
        msg = JSON.parse(e.data as string)
      } catch {
        // A frame we can't read is not a reason to abandon the turn. It used
        // to be: the parse threw inside the listener, nothing settled the
        // promise, and App's `busy` flag stayed true for the life of the page.
        return
      }

      /**
       * Somebody else's answer.
       *
       * A superseded turn keeps streaming for a moment after it is abandoned,
       * and this listener is attached to the socket rather than to a turn — so
       * without this check the tail of the old answer is read as the beginning
       * of the new one. Measured before it existed: ask for ALPHA, barge in,
       * ask for BRAVO, and BRAVO's answer came back as "ALPHA".
       */
      if (msg.ask && msg.ask !== id) return

      try {
        switch (msg.type) {
          case 'text':
            text += msg.delta ?? ''
            handlers.onText(msg.delta ?? '')
            break

          case 'tool':
            if (!msg.name) break
            tools.push(msg.name)
            handlers.onTool(msg.detail || prettyToolName(msg.name), msg.name)
            break

          case 'done':
            finish(msg.text ?? '')
            break

          case 'error':
            fail(new Error(msg.message ?? 'The bridge reported an error.'))
            break
        }
      } catch (err) {
        fail(err instanceof Error ? err : new Error(String(err)))
      }
    }

    const onClose = () => {
      fail(new Error('The bridge disconnected mid-answer — that session is gone.'))
    }
    const onError = () => {
      fail(new Error('The connection to the bridge failed.'))
    }

    pending = { finish }
    ws.addEventListener('message', onMessage)
    ws.addEventListener('close', onClose)
    ws.addEventListener('error', onError)
    arm()

    try {
      ws.send(JSON.stringify({ type: 'ask', text: prompt, id }))
    } catch (err) {
      // The socket can go into CLOSING between connect() resolving and here.
      fail(err instanceof Error ? err : new Error(String(err)))
    }
  })
}

/**
 * Cut JARVIS off mid-answer.
 *
 * Tells the bridge to stop, then settles the in-flight turn here rather than
 * waiting for a 'done' that a barge-in may never produce. Whatever he had
 * already said is returned, so the caller's await always comes back and the
 * transcript keeps the half-sentence the user actually heard.
 */
export function cancel(): void {
  if (socket?.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify({ type: 'interrupt' }))
  }
  pending?.finish()
}

/** The older name for `cancel()`. */
export function interrupt(): void {
  cancel()
}

/** `mcp__claude_ai_Gmail__search_threads` -> `Gmail · search threads` */
function prettyToolName(raw: string): string {
  if (!raw.startsWith('mcp__')) return raw
  const [, server, ...rest] = raw.split('__')
  return `${server.replace(/^claude_ai_/, '').replace(/_/g, ' ')} · ${rest.join(' ').replace(/[_-]/g, ' ')}`
}
