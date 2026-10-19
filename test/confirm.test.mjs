import { test } from 'node:test'
import assert from 'node:assert/strict'
import { decideTool, DEFAULT_HQ_URL } from '../bridge/policy.mjs'
import { createConfirmations, isClearYes, describeAction, CONFIRM_TTL_MS } from '../bridge/confirm.mjs'

const DRAFT = 'mcp__claude_ai_Gmail__create_draft'
const draft = (over = {}) => ({ to: ['shirley@nofcu.org'], subject: 'Demo login', body: 'Hi Shirley,\nHere is your login.', ...over })

function setup() {
  let t = Date.parse('2026-10-15T14:00:00Z')
  const confirm = createConfirmations({ now: () => t })
  const opts = { hqUrl: DEFAULT_HQ_URL, confirm }
  // One call through both gates, as the bridge runs it.
  const call = (name, input, extra = {}) => {
    const hook = decideTool(name, input, { ...opts, stage: 'hook', ...extra })
    if (!hook.allow) return hook
    return decideTool(name, input, { ...opts, stage: 'final', ...extra })
  }
  return { confirm, call, tick: (ms) => (t += ms) }
}

test('an unconfirmed write is refused with a readback the bridge wrote', () => {
  const { call } = setup()
  const v = call(DRAFT, draft())
  assert.equal(v.allow, false)
  assert.match(v.reason, /spoken yes/)
  assert.match(v.confirm, /draft email to shirley@nofcu\.org/)
  assert.match(v.confirm, /subject "Demo login"/)
  assert.match(v.confirm, /saying: Hi Shirley,/)
})

test('a confirmed exact write runs once, through both gates', () => {
  const { confirm, call } = setup()
  call(DRAFT, draft())
  assert.deepEqual(confirm.onUserText('Yes, do it').approved.length, 1)
  assert.equal(call(DRAFT, draft()).allow, true)
  // Used up: the same call again needs a new yes.
  assert.equal(call(DRAFT, draft()).allow, false)
})

test('changed arguments are a new action and are refused', () => {
  const { confirm, call } = setup()
  call(DRAFT, draft())
  confirm.onUserText('yes')
  assert.equal(call(DRAFT, draft({ to: ['someone-else@example.com'] })).allow, false)
  assert.equal(call(DRAFT, draft({ subject: 'Demo login!' })).allow, false)
})

test('key order does not matter, values do', () => {
  const { confirm, call } = setup()
  call(DRAFT, { subject: 'A', to: ['x@y.io'], body: 'b' })
  confirm.onUserText('send it')
  assert.equal(call(DRAFT, { body: 'b', to: ['x@y.io'], subject: 'A' }).allow, true)
})

test('anything but a clear yes cancels', () => {
  const { confirm, call } = setup()
  call(DRAFT, draft())
  const r = confirm.onUserText('yes but change the subject')
  assert.equal(r.approved.length, 0)
  assert.equal(r.cancelled.length, 1)
  assert.equal(call(DRAFT, draft()).allow, false)
})

test('a yes that comes too late approves nothing, and approvals expire', () => {
  const a = setup()
  a.call(DRAFT, draft())
  a.tick(CONFIRM_TTL_MS + 1000)
  assert.equal(a.confirm.onUserText('yes').approved.length, 0)

  const b = setup()
  b.call(DRAFT, draft())
  b.confirm.onUserText('yes')
  b.tick(CONFIRM_TTL_MS + 1000)
  assert.equal(b.call(DRAFT, draft()).allow, false)
})

test('the hook alone cannot reuse an approval', () => {
  const { confirm } = setup()
  const opts = { hqUrl: DEFAULT_HQ_URL, confirm, stage: 'hook' }
  decideTool(DRAFT, draft(), opts)
  confirm.onUserText('yes')
  assert.equal(decideTool(DRAFT, draft(), opts).allow, true)
  assert.equal(decideTool(DRAFT, draft(), opts).allow, false)
})

test('the researcher never acts, even after a yes', () => {
  const { confirm, call } = setup()
  call(DRAFT, draft())
  confirm.onUserText('yes')
  assert.equal(call(DRAFT, draft(), { fromAgent: true }).allow, false)
})

test('no confirmation store means no actions', () => {
  assert.equal(decideTool(DRAFT, draft(), {}).allow, false)
})

test('sending, replying, deleting and other blocked actions stay refused after a yes', () => {
  const { confirm, call } = setup()
  for (const name of [
    'mcp__claude_ai_Gmail__send_message',
    'mcp__claude_ai_Gmail__reply',
    'mcp__claude_ai_Gmail__forward',
    'mcp__claude_ai_Gmail__trash_thread',
    'mcp__claude_ai_Gmail__label_thread',
    'mcp__claude_ai_Google_Calendar__delete_event',
    'mcp__claude_ai_Notion__notion-delete-pages',
    'mcp__claude_ai_Attio__update-record',
    'mcp__claude_ai_Google_Drive__share_file',
    'mcp__claude_ai_Mercury__getTransferMoneyApprovalRequest',
    'mcp__claude_ai_Intuit_QuickBooks__qbo_sales_send_invoice',
    'mcp__claude_ai_Shopify__update-product',
    'Bash',
  ]) {
    call(name, { x: 1 })
    confirm.onUserText('yes')
    assert.equal(call(name, { x: 1 }).allow, false, name)
  }
  const del = { action: 'delete', url: DEFAULT_HQ_URL, collection: 'commitments', doc_id: 'c1' }
  call('ArtifactData', del)
  confirm.onUserText('yes')
  assert.equal(call('ArtifactData', del).allow, false)
})

test('calendar and notion writes follow the same rule', () => {
  const { confirm, call } = setup()
  const ev = { summary: 'NOFFCU demo', start: '2026-10-16T15:00:00-05:00', attendees: ['shirley@nofcu.org'] }
  const v = call('mcp__claude_ai_Google_Calendar__create_event', ev)
  assert.match(v.confirm, /Create the event "NOFFCU demo" at 2026-10-16T15:00:00-05:00 with shirley@nofcu\.org/)
  confirm.onUserText('yeah go ahead')
  assert.equal(call('mcp__claude_ai_Google_Calendar__create_event', ev).allow, true)
})

test('HQ writes need a fresh read, and hand-set docs are left alone', () => {
  const { confirm, call } = setup()
  const w = (doc, data = { status: 'done' }) => ({ action: 'update', url: DEFAULT_HQ_URL, collection: 'commitments', doc_id: doc, data })
  assert.match(call('ArtifactData', w('c1')).reason, /get first/)

  confirm.noteRead('commitments', 'c1', '{"id":"c1","status":"open","source":"Granola"}')
  call('ArtifactData', w('c1'))
  confirm.onUserText('yes')
  assert.equal(call('ArtifactData', w('c1')).allow, true)

  confirm.noteRead('commitments', 'c2', '{"id":"c2","done_by":"manual"}')
  assert.match(call('ArtifactData', w('c2')).reason, /by hand/)
  confirm.noteRead('commitments', 'c3', '{"id":"c3","source":"Added in HQ"}')
  assert.match(call('ArtifactData', w('c3')).reason, /by hand/)

  const today = { action: 'update', url: DEFAULT_HQ_URL, collection: 'hub', doc_id: 'today', data: { note: 'x' } }
  confirm.noteRead('hub', 'today', '{"locked": true}')
  assert.match(call('ArtifactData', today).reason, /locked/)
  assert.equal(call('ArtifactData', { ...today, doc_id: 'context' }).allow, false)
  // Pipeline stays read-only.
  const pipe = { action: 'update', url: DEFAULT_HQ_URL, collection: 'pipeline', doc_id: 'p1', data: { stage: 'won' } }
  call('ArtifactData', pipe)
  confirm.onUserText('yes')
  assert.equal(call('ArtifactData', pipe).allow, false)
})

test('the Artifact tool shape is gated the same way', () => {
  const { confirm, call } = setup()
  const w = { action: 'write_db', db_op: 'update', url: DEFAULT_HQ_URL, collection: 'tasks', doc_id: 't1', data: { status: 'done' } }
  confirm.noteRead('tasks', 't1', '{"id":"t1"}')
  assert.equal(call('Artifact', w).allow, false)
  confirm.onUserText('do it')
  assert.equal(call('Artifact', w).allow, true)
})

test('what counts as a clear yes', () => {
  for (const s of ['yes', 'Yes.', 'yeah', 'yep', 'do it', 'Send it', 'go ahead', 'yes please', 'Cortana, do it', 'yeah, go ahead', 'confirmed',
    'yes, book it', 'yes add it', 'Yes, put it on my calendar', 'yes, add it to my calendar', 'okay', 'sounds good', 'perfect', 'that works', 'go for it']) {
    assert.equal(isClearYes(s), true, s)
  }
  for (const s of ['no', 'yes but change it', 'send it to Bob', 'wait', '', 'not yet', 'yes and also email Mark',
    'yes at 3', 'okay but make it Tuesday', 'actually make it 4', 'sure, tomorrow instead', 'yes on Friday', 'yes for Bob', 'what time is it']) {
    assert.equal(isClearYes(s), false, s)
  }
})

test('describeAction never throws on odd input', () => {
  assert.equal(typeof describeAction('mcp__x__whatever', null), 'string')
  assert.equal(typeof describeAction('mcp__claude_ai_Gmail__create_draft', { to: 'a@b.c' }), 'string')
})
