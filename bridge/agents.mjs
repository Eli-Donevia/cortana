import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { decideTool } from './policy.mjs'
import { actionKey, createConfirmations, describeAction } from './confirm.mjs'

/**
 * Background agents Cortana sends out: "send an agent to pull together
 * everything on NOFFCU before Thursday".
 *
 * Each task runs as its own Claude Agent SDK session on the deep model, inside
 * the workspace it was sent from: that workspace's sources and file folder,
 * through the same policy gate as Cortana. Reads run freely. Actions never run
 * inside the agent: the gate files them as proposals with a readback the bridge
 * wrote, and they wait for Eli (a spoken "approve it", or Approve in the
 * Agents panel). An approved proposal runs once, exactly as proposed, in a
 * short executor session whose gate admits only that call. Agents cannot send
 * agents. Each has a turn budget and a time limit, and can be cancelled.
 *
 * Tasks are saved per workspace in <filesDir>/Cortana/agents/<id>.json, so the
 * list and the reports survive a restart. A task that was running when Cortana
 * stopped comes back marked as stopped.
 *
 * Pure apart from the injected runAgent/execute and the disk, so
 * test/agents.test.mjs drives it with fakes.
 */

export const MAX_PARALLEL = 4
export const AGENT_TIME_MS = 10 * 60_000
export const AGENT_MAX_TURNS = 30
const MAX_NOTES = 30

export const agentsDir = (ws) => join(ws.filesDir, 'Cortana', 'agents')

const newId = () => `ag${randomBytes(4).toString('hex')}`
const isLive = (t) => t.status === 'queued' || t.status === 'working'

/** The spoken summary of what one task is doing. */
export function describeTask(t) {
  const what = t.brief.length > 70 ? `${t.brief.slice(0, 69)}…` : t.brief
  switch (t.status) {
    case 'queued':
      return `waiting to start on ${what}`
    case 'working':
      return `working on ${what}`
    case 'needs-approval':
      return `finished ${what}, and wants your OK on ${t.proposals.filter((p) => p.status === 'pending').length} action(s)`
    case 'done':
      return `done with ${what}`
    case 'failed':
      return `stopped on ${what}: ${t.error || 'it failed'}`
    case 'cancelled':
      return `cancelled: ${what}`
    default:
      return what
  }
}

/**
 * The gate an agent runs behind: Cortana's own decideTool, with a "confirm"
 * store that never approves. Every action is filed as a proposal instead.
 */
export function agentGate(task, ws, { hqUrl, onPropose }) {
  const reads = createConfirmations()
  // The call as the agent made it; the gate may hand check() a normalised copy.
  let raw = null
  const proposer = {
    check(name, input) {
      const key = actionKey(name, input)
      if (!task.proposals.some((p) => p.key === key && p.status === 'pending')) {
        const p = {
          pid: `p${task.proposals.length + 1}`,
          key,
          tool: name,
          input: raw ?? input, // what to call again once approved
          checkInput: input, // what the gate will check it against
          seen: input?.collection && input?.doc_id ? reads.readOf(input.collection, input.doc_id) : null,
          summary: describeAction(name, input),
          status: 'pending',
        }
        task.proposals.push(p)
        onPropose?.(p)
      }
      return {
        allow: false,
        reason:
          'Queued for Eli to approve; it does not run now. Do not retry it. ' +
          'Carry on with the rest of the task and mention this proposal in your report.',
      }
    },
    onUserText() {
      return { approved: [], cancelled: [] }
    },
    noteRead: (...a) => reads.noteRead(...a),
    readOf: (...a) => reads.readOf(...a),
  }
  const opts = { hqUrl: ws.hqUrl ?? hqUrl, workspace: ws, confirm: proposer, issued: new Map() }
  const gate = (name, input, stage = 'hook') => {
    // Agents never send agents, and never use the face's display tools.
    if (name === 'Agent' || name === 'Task') return { allow: false, reason: 'Agents cannot send agents.' }
    if (/^mcp__jarvis(_ui)?__/.test(String(name))) return { allow: false, reason: 'Agents have no screen; put it in the report.' }
    raw = input
    try {
      return decideTool(name, input, { ...opts, stage })
    } finally {
      raw = null
    }
  }
  /** HQ docs the agent read, so a proposed HQ change can be checked against them. */
  gate.noteRead = proposer.noteRead
  return gate
}

/**
 * The gate for running one approved proposal: Cortana's decideTool with a
 * single-use approval for exactly that call, and nothing else.
 */
export function executorGate(p, ws, { hqUrl }) {
  const conf = createConfirmations()
  if (p.seen != null && p.checkInput?.collection) conf.noteRead(p.checkInput.collection, p.checkInput.doc_id, p.seen)
  conf.check(p.tool, p.checkInput ?? p.input)
  conf.onUserText('yes')
  const opts = { hqUrl: ws.hqUrl ?? hqUrl, workspace: ws, confirm: conf, issued: new Map() }
  let ran = false
  const gate = (name, input, stage = 'hook') => {
    if (ran && stage === 'hook') return { allow: false, reason: 'The approved action already ran.' }
    const v = decideTool(name, input, { ...opts, stage })
    if (v.allow && stage === 'hook' && name === p.tool) ran = true
    return v
  }
  gate.ran = () => ran
  return gate
}

/**
 * @param {object} p
 * @param {() => object[]} p.workspaces          the current workspace list
 * @param {string} p.hqUrl                        fallback HQ link
 * @param {(task, ctx) => Promise<string>} p.runAgent   runs one task; ctx = { gate, note, signal, ws }
 * @param {(proposal, task, ws) => Promise<string>} p.execute  runs one approved proposal
 * @param {(event) => void} [p.onEvent]           { type: 'change' | 'done' | 'needs-approval' | 'failed', task }
 * @param {() => number} [p.now]
 * @param {number} [p.cap]
 * @param {number} [p.timeMs]
 */
export function createAgentManager({ workspaces, hqUrl, runAgent, execute, onEvent = () => {}, now = () => Date.now(), cap = MAX_PARALLEL, timeMs = AGENT_TIME_MS }) {
  const tasks = new Map()
  const running = new Map() // id -> AbortController

  const wsOf = (t) => workspaces().find((w) => w.id === t.workspace)

  function save(t) {
    const ws = wsOf(t)
    if (!ws) return
    try {
      const dir = agentsDir(ws)
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, `${t.id}.json`), `${JSON.stringify(t, null, 2)}\n`)
    } catch (err) {
      console.warn(`[jarvis] could not save agent ${t.id}: ${err.message}`)
    }
  }

  function touch(t, type = 'change') {
    t.updatedAt = new Date(now()).toISOString()
    save(t)
    onEvent({ type, task: t })
  }

  function note(t, text) {
    const line = String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, 160)
    if (!line || t.notes[t.notes.length - 1] === line) return
    t.notes.push(line)
    if (t.notes.length > MAX_NOTES) t.notes.shift()
    touch(t)
  }

  function pump() {
    for (const t of [...tasks.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt))) {
      if (running.size >= cap) return
      if (t.status === 'queued') start(t)
    }
  }

  function start(t) {
    const ws = wsOf(t)
    if (!ws) {
      t.status = 'failed'
      t.error = 'its workspace no longer exists'
      return touch(t, 'failed')
    }
    const ctl = new AbortController()
    running.set(t.id, ctl)
    t.status = 'working'
    t.startedAt = new Date(now()).toISOString()
    touch(t)
    const gate = agentGate(t, ws, { hqUrl, onPropose: (p) => note(t, `Proposed: ${p.summary}`) })
    const timer = setTimeout(() => ctl.abort(new Error('ran out of time')), timeMs)
    timer.unref?.() // never the thing keeping the bridge (or a test) alive
    Promise.resolve()
      .then(() => runAgent(t, { gate, note: (s) => note(t, s), signal: ctl.signal, ws }))
      .then(
        (report) => {
          if (t.status === 'cancelled') return
          t.report = String(report ?? '').trim() || '(no report)'
          const pending = t.proposals.some((p) => p.status === 'pending')
          t.status = pending ? 'needs-approval' : 'done'
          touch(t, pending ? 'needs-approval' : 'done')
        },
        (err) => {
          if (t.status === 'cancelled') return
          t.status = 'failed'
          t.error = String(ctl.signal.aborted ? (ctl.signal.reason?.message ?? 'stopped') : (err?.message ?? err)).slice(0, 200)
          touch(t, 'failed')
        },
      )
      .finally(() => {
        clearTimeout(timer)
        running.delete(t.id)
        pump()
      })
  }

  return {
    /** Send one agent. Returns the task. */
    dispatch(brief, workspaceId) {
      const text = String(brief ?? '').trim().slice(0, 1000)
      if (!text) throw new Error('An agent needs a task.')
      const t = {
        id: newId(),
        workspace: workspaceId,
        brief: text,
        status: 'queued',
        notes: [],
        proposals: [],
        report: '',
        error: '',
        createdAt: new Date(now()).toISOString(),
        updatedAt: new Date(now()).toISOString(),
      }
      tasks.set(t.id, t)
      touch(t)
      pump()
      return t
    },

    cancel(id) {
      const t = tasks.get(id)
      if (!t || !isLive(t)) return false
      running.get(id)?.abort(new Error('cancelled'))
      t.status = 'cancelled'
      touch(t)
      pump()
      return true
    },

    /** Approve or deny one proposal. Approving runs it once, exactly as proposed. */
    async decide(id, pid, approve) {
      const t = tasks.get(id)
      const p = t?.proposals.find((x) => x.pid === pid)
      if (!t || !p || p.status !== 'pending') return { ok: false, why: 'Nothing waiting with that id.' }
      if (!approve) {
        p.status = 'denied'
      } else {
        p.status = 'approved'
        touch(t)
        try {
          p.result = String(await execute(p, t, wsOf(t))).slice(0, 500)
          p.status = 'done'
        } catch (err) {
          p.status = 'failed'
          p.result = String(err?.message ?? err).slice(0, 300)
        }
      }
      if (t.status === 'needs-approval' && !t.proposals.some((x) => x.status === 'pending')) t.status = 'done'
      touch(t)
      return { ok: true, proposal: p }
    },

    list(workspaceId) {
      return [...tasks.values()].filter((t) => !workspaceId || t.workspace === workspaceId).sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    },
    get: (id) => tasks.get(id),
    runningCount: () => running.size,

    /** Load saved tasks for every workspace. Ones that were mid-run are marked stopped. */
    load() {
      for (const ws of workspaces()) {
        let files = []
        try {
          files = readdirSync(agentsDir(ws)).filter((f) => /^ag[0-9a-f]+\.json$/.test(f))
        } catch {
          continue
        }
        for (const f of files) {
          try {
            const t = JSON.parse(readFileSync(join(agentsDir(ws), f), 'utf8'))
            if (!t?.id || tasks.has(t.id)) continue
            if (isLive(t)) {
              t.status = 'failed'
              t.error = 'Cortana restarted while it was running'
              save(t)
            }
            tasks.set(t.id, t)
          } catch {
            /* a damaged file: skip it */
          }
        }
      }
      return tasks.size
    },
  }
}

/**
 * Agent voice commands the bridge answers itself:
 * "send an agent to …", "what are my agents doing", "cancel that agent",
 * "cancel all agents", "show me what it found", "approve it", "deny it".
 */
export function agentCommand(text) {
  const t = String(text ?? '')
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/^(?:hey |ok |okay )?(?:cortana|kortana)[ ,.]*/, '')
    .trim()
  const raw = String(text ?? '').trim().replace(/^(?:hey |ok |okay )?(?:cortana|kortana)[ ,.]*/i, '')
  let m = /^(?:please )?(?:send|dispatch|spin up|start|put)(?: out)?(?: an?| another)? agents? (?:to |on |and )?(.{3,})$/i.exec(raw)
  if (m) return { type: 'dispatch', brief: m[1].replace(/[.!]+$/, '').trim() }
  m = /^(?:please )?have an agent (.{3,})$/i.exec(raw)
  if (m) return { type: 'dispatch', brief: m[1].replace(/[.!]+$/, '').trim() }
  const s = t.replace(/[.!?]+$/, '')
  if (/^(?:what are|how are|what're) (?:my |the )?agents(?: doing| up to)?$|^(?:agent|agents) status$|^status of (?:my |the )?agents$/.test(s)) return { type: 'status' }
  if (/^(?:cancel|stop|kill) (?:all|every)(?: of)?(?: my| the)? agents$/.test(s)) return { type: 'cancel-all' }
  if (/^(?:cancel|stop|kill) (?:that|the|this|my last|the last)? ?agent$/.test(s)) return { type: 'cancel' }
  if (/^(?:show me|what did|tell me) (?:what (?:it|the agent|my agent) found|it find|the (?:agent'?s )?report)$|^(?:open|show) (?:the )?(?:agent'?s? )?report$/.test(s)) return { type: 'report' }
  if (/^(?:approve|approve it|approve that|go ahead with (?:it|that)|approve the agent'?s? (?:action|request))$/.test(s)) return { type: 'approve' }
  if (/^(?:deny|deny it|deny that|reject (?:it|that)|don't do (?:it|that))$/.test(s)) return { type: 'deny' }
  return null
}
