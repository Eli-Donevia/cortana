import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseEnv, readSettings, isRichText } from '../bridge/env.mjs'

test('plain KEY=value lines, comments and quotes', () => {
  assert.deepEqual(parseEnv('# c\nA=1\nexport B = "two words"\nC=\'x\'\nD=y # note\n\n'), { A: '1', B: 'two words', C: 'x', D: 'y' })
})

test('what TextEdit does to a file still reads correctly', () => {
  const curly = 'JARVIS_TTS_ENGINE=\u201Csystem\u201D\r\nJARVIS_KOKORO_VOICE=\u2018bm_lewis\u2019\rJARVIS_WAKE=\u00A0off\u00A0'
  assert.deepEqual(parseEnv('\uFEFF' + curly), {
    JARVIS_TTS_ENGINE: 'system',
    JARVIS_KOKORO_VOICE: 'bm_lewis',
    JARVIS_WAKE: 'off',
  })
})

test('rich text is reported, not half-read', () => {
  const dir = mkdtempSync(join(tmpdir(), 'jarvis-settings-'))
  writeFileSync(join(dir, 'Jarvis settings.txt'), '{\\rtf1\\ansi\\ansicpg1252 JARVIS_TTS_ENGINE=system}')
  writeFileSync(join(dir, '.env.local'), 'JARVIS_WAKE=off\nJARVIS_TTS_ENGINE=kokoro\n')
  const s = readSettings(dir)
  assert.equal(isRichText('{\\rtf1'), true)
  assert.deepEqual(s.values, { JARVIS_WAKE: 'off', JARVIS_TTS_ENGINE: 'kokoro' })
  assert.equal(s.problems.length, 1)
  assert.match(s.problems[0], /Make Plain Text/)
})

test('"Jarvis settings.txt" wins over .env.local', () => {
  const dir = mkdtempSync(join(tmpdir(), 'jarvis-settings-'))
  writeFileSync(join(dir, 'Jarvis settings.txt'), 'JARVIS_TTS_ENGINE=system\n')
  writeFileSync(join(dir, '.env.local'), 'JARVIS_TTS_ENGINE=kokoro\nJARVIS_WAKE=off\n')
  const s = readSettings(dir)
  assert.deepEqual(s.values, { JARVIS_TTS_ENGINE: 'system', JARVIS_WAKE: 'off' })
  assert.deepEqual(s.found, ['Jarvis settings.txt', '.env.local'])
})

test('Node version range matches what Vite needs', async () => {
  const { nodeOk } = await import('../scripts/node-check.mjs')
  for (const v of ['20.19.0', 'v20.19.5', '22.12.0', '22.20.1', '23.0.0', '24.13.0', '26.1.0']) assert.equal(nodeOk(v), true, v)
  for (const v of ['18.20.0', '20.0.0', '20.18.3', '21.7.3', '22.0.0', '22.11.0', 'x']) assert.equal(nodeOk(v), false, v)
})
