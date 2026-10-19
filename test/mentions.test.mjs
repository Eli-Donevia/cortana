// Claude Code reads "@path" in a user message as a file mention and attaches
// the file with an implicit Read, before any tool call the gate could see.
// Claude Code's file-mention rules, as in the build bundled with
// @anthropic-ai/claude-agent-sdk 0.3.293. A mention starts at an "@" that opens
// a whitespace-separated word or follows one of SEP; quoted @"..." mentions are
// matched by pattern. The last test re-reads these rules from the installed
// binary, so an SDK upgrade that changes them fails here until this file (and
// bridge/ask.mjs) are re-checked.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { checkAsk } from '../bridge/ask.mjs'

const SEP = '\u3002\u3001\uFF1F\uFF01'
const QUOTED = [
  new RegExp(String.raw`(^|[\s${SEP}])@"([\w:.@-]+) \(agent\)"`, 'g'),
  new RegExp(String.raw`(^|[\s${SEP}])@"([^"]+)"`, 'g'),
  new RegExp(String.raw`(^|[\s${SEP}])@(agent-[\w:.@-]+)`, 'g'),
]

/** Every mention Claude Code would try to resolve in this text. */
function liveMentions(text) {
  const out = []
  for (const re of QUOTED) for (const m of text.matchAll(re)) if (m[2]) out.push(m[2])
  for (const [word] of text.matchAll(/[^\s]+/g)) {
    let g = word.indexOf('@')
    while (g > 0 && !SEP.includes(word[g - 1])) g = word.indexOf('@', g + 1)
    if (g !== -1 && word.length > g + 1) out.push(word.slice(g + 1))
  }
  return out
}

/** Signatures of those rules in the minified CLI. */
const CLI_SIGNATURES = [
  'Yke="\\u3002\\u3001\\uFF1F\\uFF01"',
  'String.raw`(^|${s4})@"([^"]+)"`',
  'String.raw`(^|${s4})@"([\\w:.@-]+) \\(agent\\)"`',
  'String.raw`(^|${s4})@(agent-[\\w:.@-]+)`',
  'let g=s.indexOf("@");while(g>0&&!Yke.includes(s[g-1]))g=s.indexOf("@",g+1)',
]

const PREFIXES = ['', ' ', '\n', '\t', '(', '[', '"', "'", '\u3002', '\u3001', '\uFF1F', '\uFF01',
  '\u00A0', '\u3000', '\u2028', ',', ';', ':', '<', '>', '{', '|', '\\', '/', '`', '*', '#', '=', '?', '!',
  '\u200B', '\uFEFF', '\u0301', '\uFF08']
const TARGETS = ['~/.ssh/id_ed25519', '/etc/passwd', '"~/My Keys/id_rsa"', '.env.local',
  'agent-general-purpose', '"evil (agent)"', 'server:file:///etc/hosts', '@~/.ssh/id_rsa', '\u200B@x']

test('no @ mention survives checkAsk, whatever comes before it', () => {
  for (const p of PREFIXES) {
    for (const t of TARGETS) {
      for (const lead of ['thanks', 'ok', '']) {
        const raw = `${lead}${p}@${t}`
        const r = checkAsk(raw)
        if (!r.ok) continue // refused outright ("/..." or "!...")
        assert.deepEqual(liveMentions(r.text), [], JSON.stringify(raw) + ' -> ' + JSON.stringify(r.text))
      }
    }
  }
})

test('the audit bypasses are closed', () => {
  for (const raw of [
    'thanks\u3002@/tmp/canary.txt',
    'ok\uFF1F@/tmp/two.txt',
    'wow\uFF01@/tmp/three.txt',
    "what's next\u3001@~/.ssh/id_ed25519",
  ]) {
    const r = checkAsk(raw)
    assert.equal(r.ok, true)
    assert.deepEqual(liveMentions(r.text), [], raw)
    // Unguarded, these would have been attached.
    assert.notDeepEqual(liveMentions(raw), [], 'pattern sanity: ' + raw)
  }
})

test('email addresses keep their @', () => {
  assert.equal(checkAsk('email eli@127group.io back').text, 'email eli@127group.io back')
  assert.equal(checkAsk('a.b+c_d%e-f@x.io').text, 'a.b+c_d%e-f@x.io')
})

function bundledCli() {
  const require = createRequire(import.meta.url)
  let sdkDir
  try {
    sdkDir = dirname(require.resolve('@anthropic-ai/claude-agent-sdk'))
  } catch {
    return null
  }
  const plat = `${process.platform}-${process.arch}`
  for (const name of [`claude-agent-sdk-${plat}`, `claude-agent-sdk-${plat}-musl`]) {
    for (const base of [join(sdkDir, '..'), join(sdkDir, 'node_modules', '@anthropic-ai')]) {
      const p = join(base, name, process.platform === 'win32' ? 'claude.exe' : 'claude')
      if (existsSync(p)) return p
    }
  }
  return null
}

test('the bundled Claude Code still uses exactly these mention rules', (t) => {
  const cli = bundledCli()
  if (!cli) return t.skip('no bundled Claude Code binary for this platform')
  const bin = readFileSync(cli).toString('latin1')
  for (const sig of CLI_SIGNATURES) {
    assert.ok(bin.includes(sig), `Claude Code changed its @-mention rules (${sig}); re-check bridge/ask.mjs and update this file`)
  }
})
