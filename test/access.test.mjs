import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  faceOrigins,
  originAllowed,
  hostAllowed,
  tokenMatches,
  tokenFromProtocols,
  newToken,
} from '../bridge/access.mjs'
import { checkAsk } from '../bridge/ask.mjs'

test('only the face origin is trusted, not other local dev servers', () => {
  const o = faceOrigins()
  assert.equal(originAllowed('http://127.0.0.1:5173', o), true)
  assert.equal(originAllowed('http://127.0.0.1:5173/', o), true)
  for (const bad of [
    // localhost may resolve to [::1], where another project's dev server can sit.
    'http://localhost:5173', 'http://[::1]:5173',
    'http://localhost:5174', 'http://127.0.0.1:5199', 'http://localhost:4173', 'http://[::1]:5174',
    'https://localhost:5173', 'http://localhost:3000', 'https://evil.example', 'null',
  ]) {
    assert.equal(originAllowed(bad, o), false, bad)
  }
  assert.equal(originAllowed(undefined, o), false)
  assert.equal(originAllowed(undefined, o, { allowNoOrigin: true }), true)
  const extra = faceOrigins({ extra: ['http://localhost:6006/'] })
  assert.equal(originAllowed('http://localhost:6006', extra), true)
})

test('Host must be loopback on the bridge port (DNS rebinding)', () => {
  assert.equal(hostAllowed('127.0.0.1:8787', 8787), true)
  assert.equal(hostAllowed('localhost:8787', 8787), true)
  assert.equal(hostAllowed('[::1]:8787', 8787), true)
  assert.equal(hostAllowed('rebind.attacker.example:8787', 8787), false)
  assert.equal(hostAllowed('127.0.0.1:8799', 8787), false)
  assert.equal(hostAllowed('127.0.0.1', 8787), false)
  assert.equal(hostAllowed(undefined, 8787), false)
})

test('the launch token is checked exactly', () => {
  const t = newToken()
  assert.match(t, /^[a-f0-9]{32}$/)
  assert.notEqual(newToken(), t)
  assert.equal(tokenMatches(t, t), true)
  assert.equal(tokenMatches(t.replace(/.$/, (c) => (c === 'a' ? 'b' : 'a')), t), false)
  assert.equal(tokenMatches('', t), false)
  assert.equal(tokenMatches(null, t), false)
  assert.equal(tokenMatches(t.slice(0, 20), t), false)
  assert.equal(tokenFromProtocols(`donevia-jarvis, jt.${t}`), t)
  assert.equal(tokenFromProtocols('donevia-jarvis'), null)
  assert.equal(tokenFromProtocols(undefined), null)
})

test('slash and shell commands never reach Claude Code', () => {
  for (const bad of [
    '/config permissionMode=acceptEdits remoteControl=true',
    '/heapdump',
    '/model opus',
    ' /config theme=dark',
    '\n/config theme=dark',
    '\u00a0\u200b/design-consent',
    '\uff0fconfig',
    '!rm -rf ~',
    '  !ls',
  ]) {
    const r = checkAsk(bad)
    assert.equal(r.ok, false, JSON.stringify(bad))
    assert.match(r.reason, /refused/)
  }
  assert.equal(checkAsk('').ok, false)
  assert.equal(checkAsk('   ').ok, false)
  assert.equal(checkAsk(42).ok, false)
})

test('ordinary questions pass, with @file mentions defused', () => {
  assert.deepEqual(checkAsk('What needs me today?'), { ok: true, text: 'What needs me today?' })
  assert.equal(checkAsk('  what is 3/4 of the pipeline').text, 'what is 3/4 of the pipeline')
  assert.equal(checkAsk('email eli@127group.io back').text, 'email eli@127group.io back')
  const m = checkAsk('summarise @~/.ssh/id_rsa please')
  assert.equal(m.ok, true)
  assert.ok(!/(^|\s)@~/.test(m.text))
  assert.ok(m.text.includes('\uff20~/.ssh'))
  assert.equal(checkAsk('@README.md').text, '\uff20README.md')
  assert.equal(checkAsk('x'.repeat(5000)).text.length, 4000)
})
