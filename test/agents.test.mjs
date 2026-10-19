import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { agentCommand, agentGate, agentsDir, createAgentManager, executorGate } from '../bridge/agents.mjs'
import { DEFAULT_HQ_URL } from '../bridge/policy.mjs'

const DRAFT = 'mcp__claude_ai_Gmail__create_draft'

function workspaces() {
  const base = mkdtempSync(join(tmpdir(), 'cortana-agents-'))
  return [
    { id: 'donevia', name: 'Donevia', hqUrl: DEFAULT_HQ_URL, services: ['gmail', 'mercury'], filesDir: join(base, 'Donevia'), gmailQuery: '' },
    { id: 'uncertified', name: 'Uncertified', hqUrl: null, services: ['shopify'], filesDir: join(base, 'Uncertified'), gmailQuery: '' },
  ]
}

/** A fake agent: runs `script(ctx)` and resolves when `release` is called (or at once). */
function harness({ hold = false, script = async () => 'report' } = {}) {
  const ws = workspaces()
  const releases = []
  const events = []
  const executed = []
  const m = createAgentManager({
    workspaces: () => ws,
    hqUrl: DEFAULT_HQ_URL,
    runAgent: async (task, ctx) => {
      if (hold) await new Promise((r, j) => {
        releases.push(r)
        ctx.signal.addEventListener('abort', () => j(ctx.signal.reason))
      })
      return script(ctx, task)
    },
    execute: async (p) => {
      executed.push(p)
      return 'ok'
    },
    onEvent: (e) => events.push(e.type),
  })
  return { m, ws, releases, events, executed }
}

const settle = () => new Promise((r) => setTimeout(r, 10))

test('dispatch runs an agent and keeps its report', async () => {
  const { m, events } = harness({ script: async (ctx) => (ctx.note('Looking at mail'), 'Shirley replied on Tuesday.') })
  const t = m.dispatch('check whether Shirley replied', 'donevia')
  await settle()
  assert.equal(t.status, 'done')
  assert.equal(t.report, 'Shirley replied on Tuesday.')
  assert.ok(t.notes.includes('Looking at mail'))
  assert.ok(events.includes('done'))
})

test('at most four agents run at once; the rest queue and start as others finish', async () => {
  const { m, releases } = harness({ hold: true })
  const ts = [1, 2, 3, 4, 5, 6].map((i) => m.dispatch(`task ${i}`, 'donevia'))
  await settle()
  assert.equal(m.runningCount(), 4)
  assert.equal(ts.filter((t) => t.status === 'queued').length, 2)
  releases.shift()()
  await settle()
  assert.equal(m.runningCount(), 4)
  assert.equal(ts.filter((t) => t.status === 'queued').length, 1)
})

test('an agent cannot act: the action is held as a proposal until Eli approves it', async () => {
  const { m, executed } = harness({
    script: async (ctx) => {
      const v = ctx.gate(DRAFT, { to: ['shirley@nofcu.org'], subject: 'Login', body: 'Hi' })
      assert.equal(v.allow, false)
      assert.match(v.reason, /Queued for Eli/)
      assert.equal(ctx.gate('mcp__claude_ai_Gmail__search_threads', { query: 'x' }).allow, true)
      return 'Drafted a note for you to approve.'
    },
  })
  const t = m.dispatch('draft Shirley her login', 'donevia')
  await settle()
  assert.equal(t.status, 'needs-approval')
  assert.equal(executed.length, 0)
  const p = t.proposals[0]
  assert.match(p.summary, /draft email to shirley@nofcu\.org/)
  await m.decide(t.id, p.pid, true)
  assert.equal(executed.length, 1)
  assert.equal(p.status, 'done')
  assert.equal(t.status, 'done')
  // Used once.
  assert.equal((await m.decide(t.id, p.pid, true)).ok, false)
})

test('denied proposals never run', async () => {
  const { m, executed } = harness({ script: async (ctx) => (ctx.gate(DRAFT, { to: ['a@b.co'] }), 'r') })
  const t = m.dispatch('draft something', 'donevia')
  await settle()
  await m.decide(t.id, t.proposals[0].pid, false)
  assert.equal(executed.length, 0)
  assert.equal(t.proposals[0].status, 'denied')
  assert.equal(t.status, 'done')
})

test('the executor gate allows exactly the approved call, once', () => {
  const ws = workspaces()[0]
  const task = { proposals: [] }
  const gate = agentGate(task, ws, { hqUrl: DEFAULT_HQ_URL })
  gate(DRAFT, { to: ['a@b.co'], subject: 'Hi' })
  const p = task.proposals[0]
  const ex = executorGate(p, ws, { hqUrl: DEFAULT_HQ_URL })
  assert.equal(ex(DRAFT, { to: ['evil@x.co'], subject: 'Hi' }).allow, false)
  assert.equal(ex(DRAFT, { to: ['a@b.co'], subject: 'Hi' }).allow, true)
  assert.equal(ex(DRAFT, { to: ['a@b.co'], subject: 'Hi' }).allow, false)
  assert.equal(ex.ran(), true)
})

test('agents stay in their workspace, never send agents, and never get blocked actions', () => {
  const [donevia, uncertified] = workspaces()
  const g1 = agentGate({ proposals: [] }, uncertified, { hqUrl: DEFAULT_HQ_URL })
  assert.equal(g1('mcp__claude_ai_Shopify__list-orders', {}).allow, true)
  assert.equal(g1('mcp__claude_ai_Mercury__getAccounts', {}).allow, false)
  assert.equal(g1('ArtifactData', { action: 'list', url: DEFAULT_HQ_URL, collection: 'pipeline' }).allow, false)
  const g2 = agentGate({ proposals: [] }, donevia, { hqUrl: DEFAULT_HQ_URL })
  assert.equal(g2('mcp__claude_ai_Mercury__getAccounts', {}).allow, true)
  assert.equal(g2('Agent', { subagent_type: 'researcher', prompt: 'x' }).allow, false)
  assert.equal(g2('Bash', { command: 'ls' }).allow, false)
  assert.equal(g2('mcp__claude_ai_Gmail__send_message', { to: 'a@b.co' }).allow, false)
  assert.equal(g2('mcp__jarvis__display', { html: 'x' }).allow, false)
})

test('cancel stops a running agent and frees its slot', async () => {
  const { m } = harness({ hold: true })
  const a = m.dispatch('long task', 'donevia')
  await settle()
  assert.equal(m.cancel(a.id), true)
  await settle()
  assert.equal(a.status, 'cancelled')
  assert.equal(m.runningCount(), 0)
  assert.equal(m.cancel(a.id), false)
})

test('tasks are saved per workspace and survive a restart; a mid-run task comes back stopped', async () => {
  const ws = workspaces()
  const mk = () =>
    createAgentManager({ workspaces: () => ws, hqUrl: DEFAULT_HQ_URL, runAgent: () => new Promise(() => {}), execute: async () => 'ok' })
  const m1 = mk()
  const t = m1.dispatch('pull the pipeline', 'uncertified')
  await settle()
  assert.ok(readdirSync(agentsDir(ws[1])).includes(`${t.id}.json`))
  const m2 = mk()
  assert.equal(m2.load(), 1)
  assert.equal(m2.get(t.id).status, 'failed')
  assert.match(m2.get(t.id).error, /restarted/)
  assert.equal(m2.list('donevia').length, 0)
  assert.equal(m2.list('uncertified').length, 1)
})

test('agent voice commands', () => {
  assert.deepEqual(agentCommand('Send an agent to pull everything on NOFFCU before Thursday.'), {
    type: 'dispatch',
    brief: 'pull everything on NOFFCU before Thursday',
  })
  assert.deepEqual(agentCommand('Cortana, have an agent check the Shopify orders'), { type: 'dispatch', brief: 'check the Shopify orders' })
  assert.deepEqual(agentCommand('what are my agents doing?'), { type: 'status' })
  assert.deepEqual(agentCommand('cancel that agent'), { type: 'cancel' })
  assert.deepEqual(agentCommand('cancel all agents'), { type: 'cancel-all' })
  assert.deepEqual(agentCommand('show me what it found'), { type: 'report' })
  assert.deepEqual(agentCommand('approve it'), { type: 'approve' })
  assert.deepEqual(agentCommand('deny it'), { type: 'deny' })
  assert.equal(agentCommand("what's on my calendar"), null)
})
