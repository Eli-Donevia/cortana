import { test } from 'node:test'
import assert from 'node:assert/strict'
import { classifyDataPath, describeDataPath, pickLocalServers, isClaudeAiLogin, loginState } from '../bridge/datapath.mjs'
import { parseEnv } from '../bridge/env.mjs'
import { commandCall, newCommandId, toHqCommand } from '../bridge/panels.mjs'
import { decideTool, DEFAULT_HQ_URL } from '../bridge/policy.mjs'

const MAX = { email: 'eli@example.com', subscriptionType: 'max', apiKeySource: 'none', apiProvider: 'firstParty' }
const CONNECTORS = [
  { name: 'claude.ai Gmail', status: 'connected', scope: 'claudeai' },
  { name: 'claude.ai Google Calendar', status: 'pending', scope: 'claudeai' },
  { name: 'claude.ai Granola', status: 'needs-auth', scope: 'claudeai' },
  { name: 'claude.ai Mercury', status: 'connected', scope: 'claudeai' },
  { name: 'claude.ai Claude Docs', status: 'connected', scope: 'claudeai' },
]

test('a claude.ai login before the first turn expects the HQ database', () => {
  const p = classifyDataPath({ account: MAX, mcpStatus: CONNECTORS })
  assert.equal(p.active, 'hq-db')
  assert.equal(p.hqDb, 'expected')
  // Mercury and Claude Docs are readable since Oct 16 (reads only).
  assert.deepEqual(p.connectors, ['Gmail', 'Google Calendar', 'Mercury', 'Claude Docs'])
  assert.ok(p.notes.some((n) => /Granola/.test(n)))
  assert.match(describeDataPath(p), /HQ database \(expected\).*Gmail, Google Calendar, Mercury, Claude Docs/)
})

test('the init tool list confirms or rules out the HQ database', () => {
  assert.equal(classifyDataPath({ account: MAX, initTools: ['ToolSearch', 'ArtifactData'] }).hqDb, 'confirmed')
  const viaArtifact = classifyDataPath({ account: MAX, initTools: ['Artifact'] })
  assert.equal(viaArtifact.hqTool, 'Artifact')
  const none = classifyDataPath({ account: MAX, mcpStatus: CONNECTORS, initTools: ['ToolSearch'] })
  assert.equal(none.hqDb, 'unavailable')
  assert.equal(none.active, 'connectors')
  assert.ok(none.notes.some((n) => /claude update/.test(n)))
})

test('an API-key login falls back to local MCP servers', () => {
  const api = { apiKeySource: 'ANTHROPIC_API_KEY', subscriptionType: 'Claude API' }
  assert.equal(isClaudeAiLogin(api), false)
  const p = classifyDataPath({
    account: api,
    mcpStatus: [{ name: 'notion', status: 'connected', scope: 'user' }],
    localServers: ['notion'],
  })
  assert.equal(p.active, 'local-mcp')
  assert.deepEqual(p.localMcp, ['notion'])
  assert.ok(p.notes.some((n) => /login/.test(n)))
})

test('nothing configured is reported as none, with the reason', () => {
  const p = classifyDataPath({ authError: 'not logged in' })
  assert.equal(p.active, 'none')
  assert.match(p.notes[0], /not logged in/)
  assert.equal(describeDataPath(p), 'no data source')
})

test('only readable services are passed through from ~/.claude.json', () => {
  const picked = pickLocalServers({
    notion: { type: 'http', url: 'https://mcp.notion.com/mcp' },
    granola: { type: 'http', url: 'https://mcp.granola.ai/mcp' },
    mercury: { type: 'http', url: 'https://mcp.mercury.com' },
    playwright: { command: 'npx' },
    higgsfield: { command: 'x' },
  })
  assert.deepEqual(Object.keys(picked).sort(), ['granola', 'mercury', 'notion'])
})

test('.env.local parsing', () => {
  const env = parseEnv('# comment\nA=1\nexport B="two words"\nC = three # trailing\nD=\n bad line\nE=\'x#y\'')
  assert.deepEqual(env, { A: '1', B: 'two words', C: 'three', D: '', E: 'x#y' })
})

test('hq_command builds a call the policy accepts', () => {
  const id = newCommandId()
  assert.match(id, /^jv[0-9a-f]{16}$/)
  const call = commandCall({ text: 'show pipeline', hqUrl: DEFAULT_HQ_URL })
  assert.equal(call.tool, 'ArtifactData')
  const issued = new Set([call.input.doc_id])
  assert.equal(decideTool(call.tool, call.input, { issued }).allow, true)
  const viaArtifact = commandCall({ text: 'brief me', hqUrl: DEFAULT_HQ_URL, hqTool: 'Artifact' })
  assert.equal(decideTool(viaArtifact.tool, viaArtifact.input).allow, true)
})

test('hq_command maps what Eli says onto HQ display commands, and nothing else', () => {
  assert.equal(toHqCommand('Put the pipeline on the wall'), 'show pipeline')
  assert.equal(toHqCommand('show the pipeline on HQ'), 'show pipeline')
  assert.equal(toHqCommand('brief me on the wall'), 'brief me')
  assert.equal(toHqCommand('Focus NOFFCU'), 'where are we with noffcu')
  assert.equal(toHqCommand('open Ascend in HQ'), 'where are we with ascend')
  assert.equal(toHqCommand('queue a task for atlas: send the deck'), null)
  assert.equal(toHqCommand('dispatch now'), null)
  assert.equal(toHqCommand('focus on the task queue'), null)
})

test('login state tells signed out, API key and unreadable apart', () => {
  // What Claude Code 2.1 reports with nobody signed in.
  const signedOut = { subscriptionType: 'Claude API', apiProvider: 'firstParty' }
  assert.equal(loginState(signedOut), 'signed-out')
  assert.equal(loginState(MAX), 'claude-ai')
  assert.equal(loginState({ apiKeySource: 'ANTHROPIC_API_KEY', subscriptionType: 'Claude API' }), 'other-provider')
  assert.equal(loginState({ apiProvider: 'bedrock' }), 'other-provider')
  assert.equal(loginState(null, 'Native CLI binary for darwin-arm64 not found'), 'unreadable')
  assert.equal(loginState(null), 'unknown')
  const p = classifyDataPath({ account: signedOut, initTools: ['ToolSearch', 'ArtifactData'] })
  assert.equal(p.login, 'signed-out')
  assert.equal(p.hqDb, 'unavailable')
  assert.ok(p.notes.some((n) => /not signed in/.test(n)))
})
