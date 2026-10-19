// speakable() is TypeScript in the face; transpile it on the fly so it can be
// tested with plain `node --test` on any Node 20+.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import ts from 'typescript'

const src = readFileSync(new URL('../src/lib/speakable.ts', import.meta.url), 'utf8')
const js = ts.transpileModule(src, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText
const { speakable } = await import(`data:text/javascript,${encodeURIComponent(js)}`)

test('money is said in words', () => {
  assert.equal(speakable('Pipeline is $2.4M.'), 'Pipeline is 2.4 million dollars.')
  assert.equal(speakable('About $350k left'), 'About 350 thousand dollars left')
  assert.equal(speakable('$1,200 due'), '1,200 dollars due')
})

test('ranges, approximations and percentages', () => {
  assert.equal(speakable('3-5 credit unions'), '3 to 5 credit unions')
  assert.equal(speakable('~40% done'), 'about 40 percent done')
})

test('dates and ids are left alone', () => {
  assert.equal(speakable('on 2026-10-16'), 'on 2026-10-16')
})

test('markdown and links are stripped', () => {
  assert.equal(speakable('**Send** the [LOI](https://x.example/a)'), 'Send the L.O.I.')
  assert.equal(speakable('see https://claude.ai/artifact/abc'), 'see the link on screen')
})

test('Donevia shorthand', () => {
  assert.equal(speakable('Two CUs and one CU'), 'Two credit unions and one credit union')
  assert.equal(speakable('NCUA and ACH by EOD'), 'N.C.U.A. and A.C.H. by end of day')
})

test('Eli is said EE-lye', () => {
  assert.equal(speakable('Yes, Eli?'), 'Yes, Ee-lye?')
  assert.equal(speakable('Elias called'), 'Elias called')
})
