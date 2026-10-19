import { test } from 'node:test'
import assert from 'node:assert/strict'
import { agentDoc, alertDoc, alertId, briefFor, mirrorAllowed, pickable, statusDoc, taskStatus } from '../bridge/hqsync.mjs'
import { cleanAlerts, inQuietHours, parseJsonArray, planNudges, quietCommand } from '../bridge/proactive.mjs'

const task = {
  id: 'ag12ab34cd',
  brief: 'pull everything on NOFFCU',
  workspace: 'donevia',
  status: 'needs-approval',
  createdAt: '2026-10-19T05:00:00.000Z',
  updatedAt: '2026-10-19T05:04:00.000Z',
  report: 'NOFFCU signed.',
  error: '',
  proposals: [{ pid: 'p1', summary: 'Save a draft email to shirley@nofcu.org', status: 'pending' }],
}

test('the HQ sync may only write its own paths', () => {
  assert.equal(mirrorAllowed('cortana', 'status'), true)
  assert.equal(mirrorAllowed('cortana_agents', 'ag12ab34cd'), true)
  assert.equal(mirrorAllowed('alerts', alertId('Shirley signed!')), true)
  for (const [c, d] of [['cortana', 'other'], ['pipeline', 'p1'], ['commitments', 'c1'], ['hub', 'today'], ['alerts', 'a1'], ['tasks', 't1'], ['cortana_agents', '../x']]) {
    assert.equal(mirrorAllowed(c, d), false, `${c}/${d}`)
  }
})

test('status, agent and alert docs have the agreed fields', () => {
  const s = statusDoc({ online: true, workspace: { id: 'donevia', name: 'Donevia' }, phase: 'speaking', agents: [task], now: new Date('2026-10-19T05:05:00Z') })
  assert.deepEqual(s, { updatedAt: '2026-10-19T05:05:00.000Z', online: true, workspace: 'donevia', workspaceName: 'Donevia', phase: 'speaking', agentsRunning: 0, pendingApprovals: 1 })
  const a = agentDoc(task, { filesDir: '/Users/eli/Documents/Donevia' })
  assert.equal(a.report_path, '~/Documents/Donevia/Cortana/agents/ag12ab34cd.json')
  assert.equal(a.finished_at, task.updatedAt)
  assert.deepEqual(a.pending_approval, [{ pid: 'p1', summary: 'Save a draft email to shirley@nofcu.org' }])
  assert.equal(alertDoc({ text: 'x', kind: 'alert' }).source, 'Cortana')
})

test('only CORTANA tasks that are queued are picked up', () => {
  assert.equal(pickable({ agent: 'CORTANA', status: 'queued' }), true)
  assert.equal(pickable({ agent: 'SCOUT', status: 'queued' }), false)
  assert.equal(pickable({ agent: 'CORTANA', status: 'working' }), false)
  assert.equal(briefFor({ title: 'Prep NOFFCU', detail: 'one page' }), 'Prep NOFFCU: one page')
  assert.equal(taskStatus('cancelled'), 'failed')
  assert.equal(taskStatus('needs-approval'), 'needs-approval')
})

test('proactive helpers: JSON, quiet hours, nudges, alerts, snooze', () => {
  assert.deepEqual(parseJsonArray('Here you go: [{"a":1}] done'), [{ a: 1 }])
  assert.deepEqual(parseJsonArray('none'), [])
  // 23:30 and 06:00 Chicago are quiet for 22:30-07:00; noon is not.
  assert.equal(inQuietHours(new Date('2026-10-19T04:30:00Z'), '22:30-07:00'), true)
  assert.equal(inQuietHours(new Date('2026-10-19T11:00:00Z'), '22:30-07:00'), true)
  assert.equal(inQuietHours(new Date('2026-10-19T17:00:00Z'), '22:30-07:00'), false)
  assert.equal(inQuietHours(new Date(), ''), false)
  const now = Date.parse('2026-10-19T15:00:00Z')
  const n = planNudges([{ title: 'NOFFCU call', start: '2026-10-19T15:30:00Z', attendees: ['Shirley'] }, { title: 'past', start: '2026-10-19T14:00:00Z' }, { title: 'bad' }], now)
  assert.equal(n.length, 1)
  assert.equal(n[0].at, Date.parse('2026-10-19T15:25:00Z'))
  assert.match(n[0].line, /NOFFCU call starts in five minutes, with Shirley/)
  assert.equal(planNudges([{ title: 'NOFFCU call', start: '2026-10-19T15:30:00Z' }], now, new Set([n[0].key])).length, 0)
  assert.equal(cleanAlerts([{ key: 'a', line: 'x' }, { key: 'b', line: 'y' }, { key: 'c', line: 'z' }, { key: 'd', line: 'w' }]).length, 3)
  assert.equal(quietCommand('Not now.'), 'snooze')
  assert.equal(quietCommand('quiet for an hour'), 'snooze')
  assert.equal(quietCommand('you can talk again'), 'unsnooze')
  assert.equal(quietCommand('not now, but tell me later about NOFFCU'), null)
})
