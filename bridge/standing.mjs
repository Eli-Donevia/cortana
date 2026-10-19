import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/**
 * Standing permissions: the few low-risk things Cortana does without a spoken
 * yes, then reports right after. Eli chose "Calendar basics" (Oct 19), so the
 * tier holds exactly two actions and the code knows no others:
 *
 *   calendar.accept_teammate  accept (only accept) an invite whose organizer is
 *                             on the workspace's own domain, e.g. @donevia.io
 *   calendar.append_prep      add prep notes to the end of the description of
 *                             one of Eli's own upcoming events; nothing else on
 *                             the event changes and attendees are not notified
 *
 * Both are checked against the event as Cortana actually read it (organizer,
 * start, current description), never against what the model says about it, so
 * an email cannot talk her into either. Everything else, and send, delete and
 * money always, stays behind a spoken yes.
 *
 * "Stop doing things on your own" turns the tier off; "you can do things on
 * your own again" turns it back on. "What did you do on your own?" reads the
 * log. State and log: ~/Documents/Cortana/standing.json, standing-log.json.
 */

export const ACTIONS = ['calendar.accept_teammate', 'calendar.append_prep']
export const PREP_MARKER = 'Prep notes (Cortana)'
const LOG_MAX = 200

const tool = (name) => String(name ?? '').split('__').pop()
const isCalendar = (name) => /calendar/i.test(String(name ?? '').split('__')[1] ?? '')
const pick = (o, keys) => {
  for (const k of keys) if (o?.[k] !== undefined && o[k] !== null && o[k] !== '') return o[k]
  return undefined
}
const eventIdOf = (i) => pick(i, ['eventId', 'event_id', 'id'])
const emailOf = (v) => String((typeof v === 'object' ? v?.email : v) ?? '').trim().toLowerCase()
const domainOf = (email) => (/@([a-z0-9.-]+)$/.exec(emailOf(email))?.[1] ?? '')

/** The workspace's own account and domain, from its calendars (eli@donevia.io -> donevia.io). */
export function accountOf(ws) {
  const email = (ws?.calendars ?? []).map(emailOf).find((c) => /@/.test(c) && !c.includes('#')) ?? ''
  return { email, domain: domainOf(email) }
}

/** Calendar events seen in tool results, by id: organizer, start, description. */
export function createEventMemory({ now = () => Date.now() } = {}) {
  const seen = new Map()
  function walk(v, depth = 0) {
    if (depth > 6 || v == null) return
    if (typeof v === 'string') {
      const s = v.trim()
      if ((s.startsWith('{') || s.startsWith('[')) && s.length < 2_000_000) {
        try {
          walk(JSON.parse(s), depth + 1)
        } catch {
          /* not JSON */
        }
      }
      return
    }
    if (Array.isArray(v)) return v.forEach((x) => walk(x, depth + 1))
    if (typeof v !== 'object') return
    const id = v.id ?? v.eventId
    if (typeof id === 'string' && (v.organizer || v.start)) {
      seen.set(id, {
        organizer: emailOf(v.organizer),
        organizerSelf: Boolean(v.organizer?.self),
        start: Date.parse(v.start?.dateTime ?? v.start?.date ?? v.start ?? ''),
        description: typeof v.description === 'string' ? v.description : '',
        summary: String(v.summary ?? v.title ?? ''),
        at: now(),
      })
    }
    for (const x of Object.values(v)) if (x && typeof x === 'object') walk(x, depth + 1)
    if (Array.isArray(v.content)) v.content.forEach((c) => walk(c?.text, depth + 1))
  }
  return {
    note(response) {
      walk(response)
    },
    get: (id) => seen.get(id) ?? null,
  }
}

const ALLOWED_UPDATE_KEYS = new Set(['eventId', 'event_id', 'id', 'calendarId', 'calendar_id', 'description', 'sendUpdates', 'send_updates'])

/**
 * Does the standing tier cover this call? Returns { ok, action, summary } or
 * { ok: false, why }. `events` is the event memory; `ws` the active workspace.
 */
export function standingCheck(name, input, { enabled, ws, events, now = Date.now() }) {
  if (!enabled) return { ok: false, why: 'the standing tier is off' }
  if (!isCalendar(name) || !ws?.services?.includes('calendar')) return { ok: false, why: 'not a calendar call in this workspace' }
  const i = input ?? {}
  const id = eventIdOf(i)
  const ev = id ? events.get(id) : null
  const me = accountOf(ws)
  if (!ev) return { ok: false, why: 'the event was not read first' }

  if (tool(name) === 'respond_to_event') {
    const r = String(pick(i, ['response', 'responseStatus', 'status', 'rsvp']) ?? '').toLowerCase()
    if (!['accepted', 'accept', 'yes'].includes(r)) return { ok: false, why: 'only accepting is standing' }
    if (pick(i, ['comment', 'proposedStart', 'proposed_start', 'proposedNewTime'])) return { ok: false, why: 'no comments or proposed times' }
    if (!me.domain || domainOf(ev.organizer) !== me.domain) return { ok: false, why: 'the organizer is not a teammate' }
    if (ev.organizer === me.email) return { ok: false, why: 'his own event' }
    return { ok: true, action: 'calendar.accept_teammate', summary: `Accepted ${ev.organizer.split('@')[0]}'s invite${ev.summary ? ` to ${ev.summary}` : ''}` }
  }

  if (tool(name) === 'update_event') {
    for (const k of Object.keys(i)) if (!ALLOWED_UPDATE_KEYS.has(k)) return { ok: false, why: `it would change ${k}` }
    const notify = String(pick(i, ['sendUpdates', 'send_updates']) ?? 'none').toLowerCase()
    if (notify !== 'none') return { ok: false, why: 'attendees would be notified' }
    if (!(ev.organizerSelf || (me.email && ev.organizer === me.email))) return { ok: false, why: "not Eli's own event" }
    if (!(ev.start > now)) return { ok: false, why: 'not upcoming' }
    const next = typeof i.description === 'string' ? i.description : null
    if (next == null || !next.startsWith(ev.description)) return { ok: false, why: 'existing description text would change' }
    const added = next.slice(ev.description.length)
    if (!added.includes(PREP_MARKER) || added.trim().length < PREP_MARKER.length + 5) return { ok: false, why: 'the added notes are not marked' }
    if (added.length > 4000) return { ok: false, why: 'too long' }
    return { ok: true, action: 'calendar.append_prep', summary: `Added prep notes to ${ev.summary || 'your event'}` }
  }
  return { ok: false, why: 'not a standing action' }
}

export const DEFAULT_DIR = join(homedir(), 'Documents', 'Cortana')

/** On/off and the log, kept on disk. */
export function createStanding({ dir = DEFAULT_DIR, now = () => Date.now() } = {}) {
  const stateFile = join(dir, 'standing.json')
  const logFile = join(dir, 'standing-log.json')
  const read = (f, d) => {
    try {
      return existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : d
    } catch {
      return d
    }
  }
  const write = (f, v) => {
    try {
      mkdirSync(dirname(f), { recursive: true })
      writeFileSync(f, `${JSON.stringify(v, null, 2)}\n`)
    } catch (err) {
      console.warn(`[jarvis] could not save ${f}: ${err.message}`)
    }
  }
  const state = read(stateFile, null) ?? { enabled: true, actions: ACTIONS }
  // Only the actions this code knows; a hand-edited file cannot add new ones.
  state.actions = (Array.isArray(state.actions) ? state.actions : []).filter((a) => ACTIONS.includes(a))
  if (!existsSync(stateFile)) write(stateFile, state)
  let log = read(logFile, [])
  if (!Array.isArray(log)) log = []

  return {
    get enabled() {
      return Boolean(state.enabled)
    },
    allows: (action) => Boolean(state.enabled) && state.actions.includes(action),
    setEnabled(on) {
      state.enabled = Boolean(on)
      write(stateFile, state)
    },
    record(entry) {
      log.push({ at: new Date(now()).toISOString(), ...entry })
      if (log.length > LOG_MAX) log = log.slice(-LOG_MAX)
      write(logFile, log)
    },
    recent: (n = 10) => log.slice(-n).reverse(),
  }
}

/** "Stop doing things on your own" / "you can do things on your own again" / "what did you do on your own". */
export function standingCommand(text) {
  const t = String(text ?? '')
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/^(?:hey |ok |okay )?(?:cortana|kortana)[ ,.]*/, '')
    .replace(/[.!?]+$/, '')
    .trim()
  if (/^(?:stop|quit) doing (?:things|stuff) on your own$|^(?:turn off|disable) (?:standing permissions|auto(?:matic)? actions)$|^ask me (?:first|before everything)(?: from now on)?$/.test(t)) return 'off'
  if (/^you can do (?:things|stuff) on your own again$|^(?:turn on|enable) (?:standing permissions|auto(?:matic)? actions)$/.test(t)) return 'on'
  if (/^what (?:did|have) you done? on your own(?: today)?$|^what did you do (?:on your own|without asking)(?: today)?$/.test(t)) return 'log'
  return null
}
