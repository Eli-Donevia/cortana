import { useEffect, useState } from 'react'
import { cancelAgent, decideAgentAction, watchAgents, type AgentTask } from '../lib/bridge'

/**
 * The agents Cortana has sent out in this workspace: a small "Agents" button at
 * the top right that opens a list. Each row shows the task, its state and its
 * latest step; actions an agent proposed wait here with Approve and Deny (or
 * say "approve it"). The panel opens by itself when something needs an OK.
 */

const STATE: Record<AgentTask['status'], string> = {
  queued: 'Waiting',
  working: 'Working',
  'needs-approval': 'Needs your OK',
  done: 'Done',
  failed: 'Stopped',
  cancelled: 'Cancelled',
}

export function AgentsPanel() {
  const [list, setList] = useState<AgentTask[]>([])
  const [open, setOpen] = useState(false)
  const [reportOf, setReportOf] = useState<string | null>(null)

  useEffect(() => watchAgents(setList), [])
  const waiting = list.filter((t) => t.proposals.some((p) => p.status === 'pending'))
  const live = list.filter((t) => t.status === 'queued' || t.status === 'working')
  useEffect(() => {
    if (waiting.length) setOpen(true)
  }, [waiting.length])

  if (!list.length) return null
  const shown = list.filter((t) => t.status !== 'cancelled').slice(0, 8)

  return (
    <aside className={`agents ${open ? 'agents-open' : ''}`} aria-label="Agents">
      <button type="button" className="agents-toggle" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <span className={`agents-pip ${waiting.length ? 'pip-ask' : live.length ? 'pip-live' : ''}`} />
        Agents
        <span className="agents-count">{waiting.length ? `${waiting.length} need OK` : live.length ? `${live.length} working` : shown.length}</span>
      </button>
      {open && (
        <ol className="agents-list">
          {shown.map((t) => (
            <li key={t.id} className={`agent agent-${t.status}`}>
              <div className="agent-head">
                <span className="agent-brief">{t.brief}</span>
                <span className="agent-state">{STATE[t.status]}</span>
              </div>
              {(t.status === 'working' || t.status === 'queued') && t.note && <p className="agent-note">{t.note}</p>}
              {t.status === 'failed' && t.error && <p className="agent-note">{t.error}</p>}
              {t.proposals
                .filter((p) => p.status === 'pending')
                .map((p) => (
                  <div key={p.pid} className="agent-ask">
                    <p>{p.summary}</p>
                    <div className="agent-buttons">
                      <button type="button" className="agent-approve" onClick={() => decideAgentAction(t.id, p.pid, true)}>
                        Approve
                      </button>
                      <button type="button" onClick={() => decideAgentAction(t.id, p.pid, false)}>
                        Deny
                      </button>
                    </div>
                  </div>
                ))}
              {t.proposals
                .filter((p) => p.status === 'done' || p.status === 'failed')
                .map((p) => (
                  <p key={p.pid} className="agent-note">
                    {p.status === 'done' ? 'Done: ' : 'Failed: '}
                    {p.summary}
                  </p>
                ))}
              <div className="agent-buttons">
                {t.report && (
                  <button type="button" onClick={() => setReportOf(reportOf === t.id ? null : t.id)}>
                    {reportOf === t.id ? 'Hide report' : 'Open report'}
                  </button>
                )}
                {(t.status === 'working' || t.status === 'queued') && (
                  <button type="button" onClick={() => cancelAgent(t.id)}>
                    Cancel
                  </button>
                )}
              </div>
              {reportOf === t.id && <div className="agent-report">{t.report}</div>}
            </li>
          ))}
        </ol>
      )}
    </aside>
  )
}
