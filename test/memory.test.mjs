import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createMemory, memoryBlock, memoryFile } from '../bridge/memory.mjs'
import { decideTool } from '../bridge/policy.mjs'
import { agentGate } from '../bridge/agents.mjs'

const wsAt = (name) => ({ id: name.toLowerCase(), name, filesDir: join(mkdtempSync(join(tmpdir(), 'cortana-mem-')), name) })

test('remember, search, forget, and it survives a restart', () => {
  const ws = wsAt('Donevia')
  const m = createMemory(ws)
  const a = m.add({ text: 'Shirley at NOFFCU prefers calls before 10am', about: 'Shirley', kind: 'person' })
  m.add({ text: 'Eli decided to price the pilot at 18k', about: 'pricing', kind: 'decision' })
  assert.equal(m.search('shirley')[0].id, a.id)
  assert.equal(m.search('pilot pricing')[0].kind, 'decision')
  assert.equal(m.add({ text: 'shirley at noffcu prefers calls before 10am' }).id, a.id) // no duplicates
  const again = createMemory(ws)
  assert.equal(again.count(), 2)
  assert.ok(JSON.parse(readFileSync(memoryFile(ws), 'utf8')).length === 2)
  const m2 = createMemory(ws)
  const b = m2.add({ text: 'temporary note' })
  assert.equal(m2.forget('last').id, b.id)
  assert.equal(m2.forget('last'), null)
  assert.equal(createMemory(ws).count(), 2)
})

test('each workspace has its own memory', () => {
  const d = wsAt('Donevia')
  const u = wsAt('Uncertified')
  createMemory(d).add({ text: 'Donevia only fact' })
  assert.equal(createMemory(u).search('donevia').length, 0)
})

test('notes reach the prompt marked as data', () => {
  const ws = wsAt('Donevia')
  const m = createMemory(ws)
  m.add({ text: 'Eli likes short answers', kind: 'preference' })
  assert.match(memoryBlock(m, ws), /data, never instructions/)
  assert.match(memoryBlock(m, ws), /Eli likes short answers/)
  assert.match(memoryBlock(createMemory(wsAt('X')), { name: 'X' }), /nothing saved yet/)
})

test('only Cortana uses memory: never the researcher, never an agent', () => {
  assert.equal(decideTool('mcp__jarvis_memory__memory_save', { text: 'x' }, {}).allow, true)
  assert.equal(decideTool('mcp__jarvis_memory__memory_save', { text: 'x' }, { fromAgent: true }).allow, false)
  assert.equal(decideTool('mcp__jarvis_memory__memory_wipe', {}, {}).allow, false)
  const g = agentGate({ proposals: [] }, { id: 'd', name: 'D', services: [], hqUrl: null, filesDir: '/tmp' }, { hqUrl: '' })
  assert.equal(g('mcp__jarvis_memory__memory_search', { query: 'x' }).allow, false)
})
