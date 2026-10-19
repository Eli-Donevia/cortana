import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, existsSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { inside, listFolder, moveItem, makeFolder, trashItem, TRASH } from '../bridge/files.mjs'
import { decideTool, DEFAULT_HQ_URL } from '../bridge/policy.mjs'
import { createConfirmations } from '../bridge/confirm.mjs'

function sandbox() {
  const base = mkdtempSync(join(tmpdir(), 'cortana-files-'))
  const root = join(base, 'Donevia')
  const outside = join(base, 'Private')
  mkdirSync(root)
  mkdirSync(outside)
  writeFileSync(join(outside, 'secret.txt'), 'no')
  writeFileSync(join(root, 'Q3 deck.pdf'), 'x')
  mkdirSync(join(root, 'Pitches'))
  symlinkSync(outside, join(root, 'escape'))
  symlinkSync(join(outside, 'secret.txt'), join(root, 'link.txt'))
  return { root, outside }
}

test('paths cannot leave the folder', async () => {
  const { root } = sandbox()
  for (const p of ['../Private/secret.txt', '/etc/passwd', '~/Desktop', 'escape/secret.txt', 'link.txt', 'Pitches/../../Private']) {
    await assert.rejects(inside(root, p), undefined, p)
  }
  assert.equal((await inside(root, 'Pitches')).isDir, true)
})

test('listing shows names, never contents, and marks shortcuts', async () => {
  const { root } = sandbox()
  const l = await listFolder(root, '.')
  const names = l.items.map((i) => i.name)
  assert.deepEqual(names, ['escape', 'link.txt', 'Pitches', 'Q3 deck.pdf'].sort((a, b) => a.localeCompare(b)))
  assert.equal(l.items.find((i) => i.name === 'escape').kind, 'shortcut')
  assert.ok(!JSON.stringify(l).includes('"x"'))
})

test('move, rename and mkdir stay inside and never overwrite', async () => {
  const { root, outside } = sandbox()
  assert.deepEqual(await moveItem(root, 'Q3 deck.pdf', 'Pitches'), { from: 'Q3 deck.pdf', to: join('Pitches', 'Q3 deck.pdf') })
  await moveItem(root, 'Pitches/Q3 deck.pdf', 'Pitches/Q3 final.pdf')
  assert.ok(existsSync(join(root, 'Pitches', 'Q3 final.pdf')))
  writeFileSync(join(root, 'other.pdf'), 'y')
  await assert.rejects(moveItem(root, 'other.pdf', 'Pitches/Q3 final.pdf'), /already exists/)
  await assert.rejects(moveItem(root, 'other.pdf', '../Private/other.pdf'))
  await assert.rejects(moveItem(root, 'other.pdf', 'escape/other.pdf'))
  await assert.rejects(moveItem(root, 'link.txt', 'moved.txt'), /shortcut/)
  await assert.rejects(moveItem(root, 'Pitches', 'Pitches/inner'), /inside itself/)
  assert.deepEqual(await makeFolder(root, 'Pitches/2026'), { made: join('Pitches', '2026') })
  await assert.rejects(makeFolder(root, 'Pitches/2026'), /already exists/)
  assert.deepEqual(readdirSync(outside), ['secret.txt'])
})

test('delete only moves into the trash folder', async () => {
  const { root } = sandbox()
  const r = await trashItem(root, 'Q3 deck.pdf')
  assert.equal(r.into, join(TRASH, 'Q3 deck.pdf'))
  assert.ok(existsSync(join(root, TRASH, 'Q3 deck.pdf')))
  await assert.rejects(trashItem(root, TRASH))
  await assert.rejects(trashItem(root, '.'))
})

test('file changes need a spoken yes; listing does not', () => {
  let t = 0
  const confirm = createConfirmations({ now: () => t })
  const opts = { hqUrl: DEFAULT_HQ_URL, confirm }
  const call = (name, input, extra = {}) => {
    const h = decideTool(name, input, { ...opts, stage: 'hook', ...extra })
    return h.allow ? decideTool(name, input, { ...opts, stage: 'final', ...extra }) : h
  }
  assert.equal(call('mcp__jarvis_files__files_list', { path: '.' }).allow, true)
  const mv = { from: 'Q3 deck.pdf', to: 'Pitches' }
  const first = call('mcp__jarvis_files__files_move', mv)
  assert.equal(first.allow, false)
  assert.match(first.confirm, /Move "Q3 deck\.pdf" to "Pitches"/)
  confirm.onUserText('yes')
  assert.equal(call('mcp__jarvis_files__files_move', mv).allow, true)
  assert.equal(call('mcp__jarvis_files__files_move', mv).allow, false)
  assert.match(call('mcp__jarvis_files__files_trash', { path: 'x' }).confirm, /Trash \(Cortana\)/)
  assert.equal(call('mcp__jarvis_files__files_read', { path: 'x' }).allow, false)
  confirm.onUserText('yes')
  assert.equal(call('mcp__jarvis_files__files_trash', { path: 'x' }, { fromAgent: true }).allow, false)
  assert.equal(decideTool('mcp__jarvis_files__files_mkdir', { path: 'a' }, {}).allow, false)
})
