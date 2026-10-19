import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ACTIONS, PREP_MARKER, createEventMemory, createStanding, standingCheck, standingCommand } from '../bridge/standing.mjs'
import { decideTool } from '../bridge/policy.mjs'
import { createConfirmations } from '../bridge/confirm.mjs'

const RSVP = 'mcp__claude_ai_Google_Calendar__respond_to_event'
const UPDATE = 'mcp__claude_ai_Google_Calendar__update_event'
const ws = { id: 'donevia', name: 'Donevia', services: ['calendar', 'gmail'], calendars: ['eli@donevia.io'] }
const NOW = Date.parse('2026-10-19T15:00:00Z')

function memory() {
  const ev = createEventMemory()
  ev.note({
    content: [
      {
        type: 'text',
        text: JSON.stringify({
          events: [
            { id: 'team1', summary: 'Product sync', organizer: { email: 'ana@donevia.io' }, start: { dateTime: '2026-10-20T15:00:00Z' } },
            { id: 'ext1', summary: 'Vendor pitch', organizer: { email: 'rep@vendor.com' }, start: { dateTime: '2026-10-20T16:00:00Z' } },
            { id: 'mine1', summary: 'NOFFCU call', organizer: { email: 'eli@donevia.io', self: true }, start: { dateTime: '2026-10-20T17:00:00Z' }, description: 'Agenda: pilot.' },
            { id: 'past1', summary: 'Old call', organizer: { email: 'eli@donevia.io', self: true }, start: { dateTime: '2026-10-18T17:00:00Z' }, description: '' },
          ],
        }),
      },
    ],
  })
  return ev
}
const check = (name, input, extra = {}) => standingCheck(name, input, { enabled: true, ws, events: memory(), now: NOW, ...extra })
const prep = `Agenda: pilot.\n\n${PREP_MARKER}:\n- Ask about the pilot timeline.`

test('accepts only teammate invites, and only accepts', () => {
  assert.equal(check(RSVP, { eventId: 'team1', response: 'accepted' }).ok, true)
  assert.match(check(RSVP, { eventId: 'team1', response: 'accepted' }).summary, /Accepted ana's invite to Product sync/)
  assert.equal(check(RSVP, { eventId: 'ext1', response: 'accepted' }).ok, false)
  assert.equal(check(RSVP, { eventId: 'team1', response: 'declined' }).ok, false)
  assert.equal(check(RSVP, { eventId: 'team1', response: 'tentative' }).ok, false)
  assert.equal(check(RSVP, { eventId: 'team1', response: 'accepted', comment: 'see you' }).ok, false)
  assert.equal(check(RSVP, { eventId: 'unread', response: 'accepted' }).ok, false)
})

test('prep notes: append only, marked, own upcoming event, nothing else changes, nobody notified', () => {
  assert.equal(check(UPDATE, { eventId: 'mine1', description: prep, sendUpdates: 'none' }).ok, true)
  assert.equal(check(UPDATE, { eventId: 'mine1', description: prep }).ok, true)
  assert.equal(check(UPDATE, { eventId: 'mine1', description: `${PREP_MARKER}: replaced it`, sendUpdates: 'none' }).ok, false)
  assert.equal(check(UPDATE, { eventId: 'mine1', description: 'Agenda: pilot. more words', sendUpdates: 'none' }).ok, false)
  assert.equal(check(UPDATE, { eventId: 'mine1', description: prep, sendUpdates: 'all' }).ok, false)
  assert.equal(check(UPDATE, { eventId: 'mine1', description: prep, start: { dateTime: 'x' } }).ok, false)
  assert.equal(check(UPDATE, { eventId: 'mine1', description: prep, attendees: [] }).ok, false)
  assert.equal(check(UPDATE, { eventId: 'team1', description: `\n\n${PREP_MARKER}: x x x x`, sendUpdates: 'none' }).ok, false)
  assert.equal(check(UPDATE, { eventId: 'past1', description: `\n\n${PREP_MARKER}: x x x x`, sendUpdates: 'none' }).ok, false)
})

test('off means off, and other workspaces and tools are never standing', () => {
  assert.equal(check(RSVP, { eventId: 'team1', response: 'accepted' }, { enabled: false }).ok, false)
  assert.equal(check(RSVP, { eventId: 'team1', response: 'accepted' }, { ws: { ...ws, services: ['gmail'] } }).ok, false)
  for (const t of ['mcp__claude_ai_Google_Calendar__create_event', 'mcp__claude_ai_Google_Calendar__delete_event', 'mcp__claude_ai_Gmail__create_draft', 'mcp__claude_ai_Gmail__send_message']) {
    assert.equal(check(t, { eventId: 'team1' }).ok, false, t)
  }
})

test('through the gate: standing runs with no yes; everything else still needs one', () => {
  const ev = memory()
  const opts = {
    workspace: ws,
    confirm: createConfirmations(),
    standing: (n, i) => standingCheck(n, i, { enabled: true, ws, events: ev, now: NOW }),
  }
  assert.equal(decideTool(RSVP, { eventId: 'team1', response: 'accepted' }, { ...opts, stage: 'hook' }).allow, true)
  assert.equal(decideTool(RSVP, { eventId: 'ext1', response: 'accepted' }, { ...opts, stage: 'hook' }).allow, false)
  assert.equal(decideTool('mcp__claude_ai_Google_Calendar__create_event', { summary: 'x' }, { ...opts, stage: 'hook' }).allow, false)
  assert.equal(decideTool(RSVP, { eventId: 'team1', response: 'accepted' }, { ...opts, stage: 'hook', fromAgent: true }).allow, false)
})

test('the switch and the log persist; a hand-edited file cannot add actions', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cortana-standing-'))
  const s = createStanding({ dir })
  assert.equal(s.enabled, true)
  assert.deepEqual(ACTIONS, ['calendar.accept_teammate', 'calendar.append_prep'])
  s.record({ action: 'calendar.accept_teammate', summary: "Accepted ana's invite" })
  s.setEnabled(false)
  const s2 = createStanding({ dir })
  assert.equal(s2.enabled, false)
  assert.equal(s2.allows('calendar.accept_teammate'), false)
  assert.equal(s2.recent(1)[0].summary, "Accepted ana's invite")
  assert.equal(createStanding({ dir }).allows('gmail.send'), false)
})

test('voice: stop, start again, and the log', () => {
  assert.equal(standingCommand('Stop doing things on your own.'), 'off')
  assert.equal(standingCommand('ask me first'), 'off')
  assert.equal(standingCommand('you can do things on your own again'), 'on')
  assert.equal(standingCommand('What did you do on your own?'), 'log')
  assert.equal(standingCommand('what did you do today'), null)
})
