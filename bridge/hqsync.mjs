/**
 * Cortana <-> HQ, prepared and OFF (JARVIS_HQ_SYNC, not wired yet: waits for
 * Eli's yes). Pure shapes only, so test/hqsync.test.mjs pins them:
 *
 *   cortana/status             one doc: is she on, which workspace, what she is doing
 *   cortana_agents/{agentId}   one doc per agent task
 *   alerts/cortana-{key}       her alerts, source "Cortana"
 *   tasks/{id}                 HQ tasks with agent == "CORTANA" are hers to run;
 *                              she writes status working / needs-approval / done / failed
 *
 * The only HQ paths the sync may ever write are the ones `mirrorAllowed` says.
 */

export const CORTANA_AGENT = 'CORTANA'

/** Collections and docs the sync may write; nothing else. */
export function mirrorAllowed(collection, docId) {
  if (collection === 'cortana') return docId === 'status'
  if (collection === 'cortana_agents') return /^ag[0-9a-f]{4,16}$/.test(String(docId))
  if (collection === 'alerts') return /^cortana-[a-z0-9-]{1,60}$/.test(String(docId))
  return false
}

export function statusDoc({ online, workspace, phase, agents, now = new Date() }) {
  const list = agents ?? []
  return {
    updatedAt: now.toISOString(),
    online: Boolean(online),
    workspace: workspace?.id ?? null,
    workspaceName: workspace?.name ?? null,
    phase: ['dormant', 'listening', 'thinking', 'speaking'].includes(phase) ? phase : 'dormant',
    agentsRunning: list.filter((t) => t.status === 'working' || t.status === 'queued').length,
    pendingApprovals: list.reduce((n, t) => n + t.proposals.filter((p) => p.status === 'pending').length, 0),
  }
}

export function agentDoc(t, ws) {
  return {
    title: t.brief.slice(0, 200),
    workspace: t.workspace,
    status: t.status,
    started_at: t.startedAt ?? t.createdAt,
    finished_at: ['done', 'failed', 'cancelled', 'needs-approval'].includes(t.status) ? t.updatedAt : null,
    summary: (t.report || t.error || '').slice(0, 300),
    report_path: ws ? `${ws.filesDir.replace(/^\/Users\/[^/]+/, '~')}/Cortana/agents/${t.id}.json` : null,
    pending_approval: t.proposals.filter((p) => p.status === 'pending').map(({ pid, summary }) => ({ pid, summary })),
  }
}

/** A stable alerts doc id for one alert key. */
export const alertId = (key) =>
  `cortana-${String(key ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'note'}`

export function alertDoc({ text, kind, workspace, now = new Date() }) {
  return { source: 'Cortana', text: String(text ?? '').slice(0, 300), kind, at: now.toISOString(), workspace: workspace ?? null }
}

/** HQ tasks Cortana should pick up: hers, queued. */
export const pickable = (task) => task && task.agent === CORTANA_AGENT && task.status === 'queued'

/** The agent brief for one HQ task. */
export const briefFor = (task) => [task.title, task.detail].filter(Boolean).join(': ').slice(0, 1000)

/** HQ task status for one Cortana agent status. */
export function taskStatus(agentStatus) {
  return { queued: 'working', working: 'working', 'needs-approval': 'needs-approval', done: 'done', failed: 'failed', cancelled: 'failed' }[agentStatus] ?? 'working'
}

// ---------------------------------------------------------------------------
// The writer: queued, coalesced, throttled; each flush is one short session
// whose gate admits exactly the queued writes (same path, same data) and
// nothing else. Eli said yes to the sync on Oct 19.
// ---------------------------------------------------------------------------

import { actionKey } from './confirm.mjs'
import { artifactId } from './policy.mjs'

const plain = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)

/** The exact HQ tool input for one write, for whichever HQ tool this Claude Code has. */
export function writeCall(hqTool, hqUrl, { collection, doc_id, op, data }) {
  return hqTool === 'Artifact'
    ? { tool: 'Artifact', input: { action: 'write_db', db_op: op, url: hqUrl, collection, doc_id, data } }
    : { tool: 'ArtifactData', input: { action: op, url: hqUrl, collection, doc_id, data } }
}

/** A gate that allows exactly these writes (and ToolSearch), once each. */
export function writesGate(writes, hqUrl) {
  const want = new Map(writes.map((w) => [actionKey('w', { c: w.collection, d: w.doc_id, op: w.op, data: w.data }), w]))
  const done = new Set()
  const gate = (name, input) => {
    if (name === 'ToolSearch') return { allow: true, reason: 'tool search' }
    if (name !== 'Artifact' && name !== 'ArtifactData') return { allow: false, reason: 'Only the listed HQ writes.' }
    const i = input ?? {}
    const op = name === 'Artifact' ? (i.action === 'write_db' ? i.db_op : null) : i.action
    if (!['set', 'update'].includes(op) || artifactId(i.url) !== artifactId(hqUrl) || !plain(i.data)) {
      return { allow: false, reason: 'Only the listed HQ writes.' }
    }
    const key = actionKey('w', { c: i.collection, d: i.doc_id, op, data: i.data })
    if (!want.has(key) || done.has(key)) return { allow: false, reason: 'Only the listed HQ writes, once each.' }
    done.add(key)
    return { allow: true, reason: 'hq sync' }
  }
  gate.noteRead = () => {}
  gate.done = () => done.size
  return gate
}

/**
 * @param {object} p
 * @param {(writes) => Promise<number>} p.flushWrites   runs one session for these writes; resolves to how many ran
 * @param {() => number} [p.now]
 */
export function createHqSync({ flushWrites, now = () => Date.now(), minGapMs = 60_000 }) {
  const pending = new Map() // "collection/doc" -> write (latest wins)
  const picked = new Set() // HQ task ids Cortana took, the only tasks/* she may update
  let lastFlush = 0
  let timer = null
  let flushing = false

  function allowed(w) {
    if (w.collection === 'tasks') return picked.has(w.doc_id) && w.op === 'update'
    return mirrorAllowed(w.collection, w.doc_id)
  }

  async function flush() {
    timer = null
    if (flushing || !pending.size) return
    flushing = true
    const writes = [...pending.values()]
    pending.clear()
    lastFlush = now()
    try {
      await flushWrites(writes)
    } catch (err) {
      console.warn(`[jarvis] HQ sync failed: ${err?.message ?? err}`)
    } finally {
      flushing = false
      if (pending.size) schedule()
    }
  }

  function schedule() {
    if (timer) return
    const wait = Math.max(0, lastFlush + minGapMs - now())
    timer = setTimeout(flush, wait)
    timer.unref?.()
  }

  return {
    /** Queue one write; refused if it is not on the allow-list. */
    queue(w) {
      if (!allowed(w)) return false
      pending.set(`${w.collection}/${w.doc_id}`, w)
      schedule()
      return true
    },
    pick: (taskId) => picked.add(taskId),
    isPicked: (taskId) => picked.has(taskId),
    pendingCount: () => pending.size,
    flush,
  }
}
