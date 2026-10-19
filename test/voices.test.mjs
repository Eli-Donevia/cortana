// The Kokoro voice list and its rules (src/lib/kokoroVoices.ts), transpiled on
// the fly like speakable.test.mjs.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import ts from 'typescript'
import { KOKORO_VOICES as SETTINGS_VOICES } from '../bridge/env.mjs'

const src = readFileSync(new URL('../src/lib/kokoroVoices.ts', import.meta.url), 'utf8')
const js = ts.transpileModule(src, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText
const V = await import(`data:text/javascript,${encodeURIComponent(js)}`)

test('every voice is an English voice that kokoro-js ships', () => {
  const dist = readFileSync(new URL('../node_modules/kokoro-js/dist/kokoro.web.js', import.meta.url), 'utf8')
  for (const id of V.KOKORO_VOICE_IDS) {
    assert.ok(existsSync(new URL(`../node_modules/kokoro-js/voices/${id}.bin`, import.meta.url)), id)
    assert.match(dist, new RegExp(`${id}:\\{name:"[A-Za-z]+",language:"en-(us|gb)"`), id)
  }
  assert.equal(new Set(V.KOKORO_VOICE_IDS).size, V.KOKORO_VOICE_IDS.length)
})

test('the settings file accepts exactly the voices V cycles, Emma first', () => {
  assert.deepEqual(SETTINGS_VOICES, V.KOKORO_VOICE_IDS)
  assert.equal(V.DEFAULT_KOKORO_VOICE, 'bf_emma')
  assert.equal(V.KOKORO_VOICE_IDS[0], 'bf_emma')
  for (const id of ['af_heart', 'af_bella', 'af_nicole', 'am_michael', 'am_fenrir', 'am_puck', 'bf_emma', 'bf_isabella', 'bm_fable']) {
    assert.ok(V.isKokoroVoice(id), id)
  }
})

test('V steps through every voice and wraps', () => {
  const seen = []
  let id = V.DEFAULT_KOKORO_VOICE
  for (let i = 0; i < V.KOKORO_VOICES.length; i++) {
    seen.push(id)
    id = V.nextVoice(id)
  }
  assert.equal(id, V.DEFAULT_KOKORO_VOICE)
  assert.deepEqual([...seen].sort(), [...V.KOKORO_VOICE_IDS].sort())
  assert.equal(V.nextVoice('nonsense'), V.KOKORO_VOICE_IDS[0])
  assert.equal(V.voiceLabel('af_heart'), 'Heart (American female)')
})

test('a pick made with V wins until the settings file changes', () => {
  assert.equal(V.chooseVoice('bm_george', null), 'bm_george')
  assert.equal(V.chooseVoice('bm_fable', null), 'bm_fable')
  assert.equal(V.chooseVoice('not_a_voice', null), 'bf_emma')
  const pick = V.savedPick('af_heart', 'bm_george')
  assert.equal(V.chooseVoice('bm_george', pick), 'af_heart')
  // Settings edited after the pick: the settings file is the newer decision.
  assert.equal(V.chooseVoice('bm_fable', pick), 'bm_fable')
  assert.equal(V.chooseVoice('bm_george', '{broken'), 'bm_george')
  assert.equal(V.chooseVoice('bm_george', JSON.stringify({ voice: 'xx_nope', base: 'bm_george' })), 'bm_george')
})

test('the HUD says why the Mac voice is speaking', () => {
  const k = { engine: 'kokoro', state: 'loading', progress: 0.423, rtf: 0 }
  assert.equal(V.fallbackNote(k), 'Mac voice: Kokoro loading 42%')
  assert.equal(V.fallbackNote({ ...k, progress: 1 }), 'Mac voice: Kokoro loading 99%')
  assert.equal(V.fallbackNote({ ...k, state: 'ready' }), '')
  assert.equal(V.fallbackNote({ ...k, engine: 'system' }), '')
  assert.match(V.fallbackNote({ ...k, state: 'slow', rtf: 1.8 }), /too slow on this Mac \(1\.8x real time\), using Mac voice/)
  assert.match(V.fallbackNote({ ...k, state: 'failed' }), /failed to load, using Mac voice/)
  assert.match(V.fallbackNote({ ...k, state: 'idle' }), /^Mac voice/)
})
