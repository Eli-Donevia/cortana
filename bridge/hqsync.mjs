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
