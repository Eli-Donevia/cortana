import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  acrossAll,
  addWorkspace,
  findWorkspace,
  loadWorkspaces,
  normalizeAll,
  seedWorkspaces,
  workspaceCommand,
} from '../bridge/workspaces.mjs'
import { buildSystemPrompt } from '../bridge/persona.mjs'

const tmp = () => join(mkdtempSync(join(tmpdir(), 'cortana-ws-')), 'workspaces.json')

test('the seed has Donevia, Uncertified and 127 Group, with Donevia active and owning HQ', () => {
  const s = seedWorkspaces()
  assert.deepEqual(s.workspaces.map((w) => w.name), ['Donevia', 'Uncertified', '127 Group'])
  assert.equal(s.active, 'donevia')
  assert.ok(s.workspaces[0].hqUrl)
  assert.equal(s.workspaces[1].hqUrl, null)
  assert.ok(s.workspaces[1].services.includes('shopify'))
  assert.ok(!s.workspaces[1].services.includes('mercury'))
})

test('a missing file is created from the seed; a broken one falls back without being overwritten', () => {
  const f = tmp()
  assert.equal(loadWorkspaces(f).workspaces.length, 3)
  assert.ok(JSON.parse(readFileSync(f, 'utf8')).workspaces.length === 3)
  writeFileSync(f, '{ not json')
  assert.equal(loadWorkspaces(f).workspaces.length, 3)
  assert.equal(readFileSync(f, 'utf8'), '{ not json')
})

test('the file is cleaned: unknown services, bad links and duplicates dropped', () => {
  const d = normalizeAll({
    active: 'nope',
    workspaces: [
      { name: 'Acme', services: ['gmail', 'bash', 'Shopify'], hqUrl: 'https://evil.example/x' },
      { name: 'acme' },
      { name: '' },
    ],
  })
  assert.equal(d.workspaces.length, 1)
  assert.deepEqual(d.workspaces[0].services, ['gmail', 'shopify'])
  assert.equal(d.workspaces[0].hqUrl, null)
  assert.equal(d.active, 'acme')
})

test('spoken names find the right workspace', () => {
  const list = seedWorkspaces().workspaces
  assert.equal(findWorkspace(list, 'uncertified').id, 'uncertified')
  assert.equal(findWorkspace(list, 'one twenty seven group'), null)
  assert.equal(findWorkspace(list, '127 group').id, '127-group')
  assert.equal(findWorkspace(list, '127').id, '127-group')
  assert.equal(findWorkspace(list, 'Donevia').id, 'donevia')
  assert.equal(findWorkspace(list, 'acme'), null)
})

test('workspace voice commands', () => {
  assert.deepEqual(workspaceCommand('Switch to Uncertified.'), { type: 'switch', name: 'uncertified' })
  assert.deepEqual(workspaceCommand('Cortana, switch over to the 127 Group workspace'), { type: 'switch', name: '127 group' })
  assert.deepEqual(workspaceCommand('which workspace am I in?'), { type: 'which' })
  assert.deepEqual(workspaceCommand('list my workspaces'), { type: 'list' })
  assert.deepEqual(workspaceCommand('add a workspace called Acme Labs'), { type: 'add', name: 'acme labs' })
  assert.equal(workspaceCommand("what's on my calendar"), null)
  assert.equal(workspaceCommand('switch the meeting to Tuesday'), null)
  // Parses as a switch, but no workspace matches, so the bridge passes it to Cortana as a question.
  assert.equal(findWorkspace(seedWorkspaces().workspaces, workspaceCommand('move to the next item').name), null)
})

test('across all companies is explicit', () => {
  assert.equal(acrossAll('what do I owe across all companies'), true)
  assert.equal(acrossAll('across all my workspaces, who emailed'), true)
  assert.equal(acrossAll('what do I owe'), false)
})

test('adding a workspace refuses duplicates', () => {
  const s = seedWorkspaces()
  assert.equal(addWorkspace(s, 'Acme').added.name, 'Acme')
  assert.equal(addWorkspace(s, 'Uncertified').added, null)
})

test('the prompt names the workspace, its sources and its Gmail filter, and never Donevia elsewhere', () => {
  const s = seedWorkspaces()
  const path = { hqDb: 'expected', hqTool: 'Artifact', connectors: ['Gmail'], localMcp: [], active: 'hq-db' }
  const unc = s.workspaces[1]
  const p = buildSystemPrompt({ path, hqUrl: unc.hqUrl, workspace: unc, others: ['Donevia', '127 Group'] })
  assert.match(p, /WORKSPACE: Uncertified/)
  assert.match(p, /add "uncertified\.co" to every search/)
  assert.match(p, /no HQ database/)
  assert.doesNotMatch(p, /credit unions/)
})
