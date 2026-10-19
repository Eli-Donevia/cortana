// The wake-word rules are TypeScript in the face; transpile them on the fly,
// the same way test/speakable.test.mjs does.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import ts from 'typescript'

const src = readFileSync(new URL('../src/lib/wake.ts', import.meta.url), 'utf8')
const js = ts.transpileModule(src, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText
const { WAKE, wakeVerdict, wakeCommand, WAKE_MIN_CONFIDENCE } = await import(`data:text/javascript,${encodeURIComponent(js)}`)

const on = { enabled: true, speaking: false }

test('only her name wakes her, as a whole word', () => {
  for (const s of ['Cortana', 'hey Cortana', 'Hey, Cortana', 'ok cortana what is next', 'Kortana']) assert.ok(WAKE.test(s), s)
  for (const s of ['cortona', 'quartana', 'cortina', 'the cortanas', "Cortana's job", 'quarter', 'uh', 'hm', 'Travis', 'Jarvis', 'cortanaa']) {
    assert.ok(!WAKE.test(s), s)
  }
})

test('a wake needs confidence where Chrome gives one', () => {
  assert.equal(wakeVerdict('Cortana', 0.9, on), '')
  assert.equal(wakeVerdict('Cortana', 0, on), '') // on-device often reports 0: no evidence either way
  assert.match(wakeVerdict('Cortana', WAKE_MIN_CONFIDENCE - 0.1, on), /low confidence/)
})

test('no wake while she is speaking, or when the switch is off', () => {
  assert.match(wakeVerdict('Cortana', 0.9, { enabled: true, speaking: true }), /echo/)
  assert.match(wakeVerdict('Cortana', 0.9, { enabled: false, speaking: false }), /off/)
  assert.equal(wakeVerdict('the weather', 0.9, on), 'not her name')
})

test('spoken switch for the wake word', () => {
  assert.equal(wakeCommand('Stop listening for your name'), false)
  assert.equal(wakeCommand('turn off the wake word'), false)
  assert.equal(wakeCommand('Start listening for your name again'), true)
  assert.equal(wakeCommand('turn on your wake word'), true)
  assert.equal(wakeCommand("what's on my calendar"), null)
})
