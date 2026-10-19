/**
 * Spoken confirmation for the few actions Cortana may take.
 *
 * Eli chose "act, but only after I confirm each one". The model cannot be the
 * one that decides it was confirmed: an email it read could tell it to say so.
 * So the bridge holds the confirmation, and it is made from what Eli actually
 * said, never from anything the model writes:
 *
 *   1. The model calls a write tool. The gate refuses it, files it as pending
 *      (bound to the exact tool and arguments), and hands back a readback the
 *      bridge wrote from those arguments: recipient, subject, first line; the
 *      event, time and attendees; the page and the change.
 *   2. Cortana reads it back and asks.
 *   3. Eli's next utterance reaches the bridge as a question. Only a clear yes
 *      ("yes", "do it", "send it") turns the pending actions into approvals.
 *      Anything else cancels them.
 *   4. The model makes the identical call again. The approval matches the
 *      exact tool and arguments, is used once, and expires after CONFIRM_TTL_MS.
 *      Changed arguments are a new action and need a new yes.
 *
 * Pure apart from the clock, so test/confirm.test.mjs covers what runs.
 */

export const CONFIRM_TTL_MS = 2 * 60_000

/** How long a hook-approved call may take to reach the second gate (canUseTool). */
const SECOND_GATE_MS = 15_000

/** How long an HQ read counts as "just read" for the protection checks. */
export const READ_FRESH_MS = 10 * 60_000

/** Connector tools that run after a spoken yes. Exact names; everything else stays refused. */
export const CONFIRM_WRITES = {
  // Drafts only: Eli presses send himself.
  gmail: ['create_draft'],
  calendar: ['create_event', 'update_event', 'respond_to_event'],
  notion: ['notion-create-pages', 'notion-update-page'],
}

/** HQ collections (and, for hub, the one doc) Cortana may change after a yes. */
export const HQ_CONFIRM = {
  commitments: null, // any doc
  tasks: null,
  hub: ['today'],
}

/** JSON with sorted keys, so the same arguments always give the same key. */
export function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .filter((k) => value[k] !== undefined)
      .map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`)
      .join(',')}}`
  }
  return JSON.stringify(value ?? null)
}

export const actionKey = (name, input) => `${name} ${canonical(input ?? {})}`

/**
 * A clear yes, and nothing else. "Yes", "yeah, send it", "Cortana, do it",
 * "go ahead please". Not "yes but change the subject", not "send it to Bob".
 */
/**
 * A clear yes: it starts with an affirmative and changes nothing.
 * Yes: "yes", "yes, book it", "yeah add it", "okay", "sounds good", "perfect",
 * "yes, put it on my calendar", "Cortana, do it".
 * Not yes: "no", "yes but at three", "send it to Bob", "yes and also email Mark",
 * "wait", "actually make it Tuesday". Anything that names a new time, person or
 * change is a new instruction, so the pending action is cancelled instead.
 */
const AFFIRM = /^(?:yes|yeah|yep|yup|ya|sure|ok|okay|correct|confirm(?:ed)?|approved?|do it|send it|book it|add it|save it|put it (?:on|in)|go ahead|go for it|please do|make it so|that's right|that is right|sounds good|perfect|great|that works|works for me|absolutely|definitely|of course)\b/
const CHANGES = /\b(?:no|nope|not|don't|dont|never|wait|hold|stop|cancel|but|instead|actually|except|change|rather|different|another|also|and then|later|tomorrow|today|tonight|move|make it|to|with|at|for|from|on (?:mon|tues|wednes|thurs|fri|satur|sun)day)\b|\d/

export function isClearYes(text) {
  let t = String(text ?? '')
    .toLowerCase()
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[^a-z0-9' ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^(?:(?:hey|ok|okay) )?(?:cortana|kortana) /, '')
  // "on my calendar" / "to the calendar" only says where the approved action goes.
  t = t.replace(/\b(?:on|to|in|onto|into) (?:my|the) (?:calendar|drafts?|inbox|notion|folder|hq)\b/g, '').replace(/\s+/g, ' ').trim()
  t = t.replace(/\bgo for it\b/g, "go ahead")
  if (!t || t.split(" ").length > 9) return false
  if (!AFFIRM.test(t)) return false
  return !CHANGES.test(t)
}

const short = (v, n = 80) => {
  const s = (typeof v === 'string' ? v : JSON.stringify(v)) ?? ''
  const one = s.replace(/\s+/g, ' ').trim()
  return one.length > n ? `${one.slice(0, n - 1)}…` : one
}

const firstLine = (v) => short(String(v ?? '').split(/\n/).find((l) => l.trim()) ?? '', 100)

const list = (v) => (Array.isArray(v) ? v.map((x) => (typeof x === 'object' ? x?.email ?? x?.name ?? short(x, 40) : x)).join(', ') : short(v, 120))

const pick = (o, keys) => {
  for (const k of keys) if (o?.[k] !== undefined && o[k] !== '') return o[k]
  return undefined
}

/**
 * What the action will do, in plain words, written by the bridge from the
 * arguments themselves. Cortana reads this back; Eli says yes to this.
 */
export function describeAction(name, input = {}) {
  const i = input ?? {}
  const tool = String(name).split('__').pop()
  const to = pick(i, ['to', 'recipients', 'recipient', 'to_addresses'])
  const cc = pick(i, ['cc'])
  const subject = pick(i, ['subject'])
  const body = pick(i, ['body', 'text', 'content', 'message', 'html_body'])
  const parts = []
  switch (tool) {
    case 'send_message':
      parts.push(`Send an email to ${list(to) || 'nobody named'}`)
      break
    case 'create_draft':
      parts.push(`Save a draft email to ${list(to) || 'nobody named'}`)
      break
    case 'reply':
      parts.push(`Send a reply${to ? ` to ${list(to)}` : ' on that thread'}`)
      break
    case 'create_event':
    case 'update_event': {
      const title = pick(i, ['summary', 'title', 'name'])
      const start = pick(i, ['start', 'start_time', 'startTime', 'start_datetime'])
      const people = pick(i, ['attendees', 'attendee_emails', 'guests'])
      parts.push(
        `${tool === 'create_event' ? 'Create' : 'Change'} the event${title ? ` "${short(title, 60)}"` : ''}` +
          `${start ? ` at ${short(start?.dateTime ?? start, 40)}` : ''}` +
          `${people ? ` with ${list(people)}` : ''}`,
      )
      break
    }
    case 'respond_to_event':
      parts.push(`Answer the invite ${short(pick(i, ['response', 'status', 'rsvp']) ?? '', 20)}`.trim())
      break
    case 'notion-create-pages':
      parts.push(`Create a Notion page${pick(i, ['title']) ? ` "${short(pick(i, ['title']), 60)}"` : ''}`)
      break
    case 'notion-update-page':
      parts.push(`Change the Notion page ${short(pick(i, ['page_id', 'pageId', 'id']) ?? '', 40)}`.trim())
      break
    case 'files_move':
      parts.push(`Move "${short(i.from, 80)}" to "${short(i.to, 80)}" in the workspace files folder`)
      break
    case 'files_mkdir':
      parts.push(`Make a folder "${short(i.path, 80)}" in the workspace files folder`)
      break
    case 'files_trash':
      parts.push(`Move "${short(i.path, 80)}" to the Trash (Cortana) folder`)
      break
    case 'ArtifactData':
    case 'Artifact': {
      const op = i.db_op ?? i.action
      parts.push(`${op === 'set' ? 'Write' : 'Update'} ${i.collection}/${i.doc_id} in HQ: ${short(i.data, 120)}`)
      break
    }
    default:
      parts.push(`Run ${tool}: ${short(i, 120)}`)
  }
  if (cc) parts.push(`copying ${list(cc)}`)
  if (subject) parts.push(`subject "${short(subject, 80)}"`)
  if (body) parts.push(`saying: ${firstLine(body)}`)
  return parts.join(', ')
}

/** Is this HQ doc, as just read, one Cortana must leave alone? Returns the reason or ''. */
export function protectedReason(collection, text) {
  const t = String(text ?? '')
  if (collection === 'commitments') {
    if (/"done_by"\s*:\s*"manual"/i.test(t)) return 'That commitment was closed by hand in HQ, so I leave it alone.'
    if (/"source"\s*:\s*"Added in HQ"/i.test(t)) return 'That commitment was added by hand in HQ, so I leave it alone.'
  }
  if (collection === 'hub' && /"locked"\s*:\s*true/i.test(t)) return "Today's plan is locked in HQ, so I leave it alone."
  if (collection === 'pipeline' && /"stage_set_by"\s*:\s*"manual"/i.test(t)) return 'That deal stage was set by hand, so I leave it alone.'
  return ''
}

/**
 * One conversation's confirmations. `now` is the clock (tests).
 */
export function createConfirmations({ now = () => Date.now(), ttl = CONFIRM_TTL_MS } = {}) {
  /** key -> { name, summary, at } : refused once, waiting for Eli. */
  const pending = new Map()
  /** key -> { expires, consumedAt? } : Eli said yes. */
  const approvals = new Map()
  /** "collection/doc" -> { text, at } : HQ docs read in this conversation. */
  const reads = new Map()

  return {
    /**
     * Gate check for one confirmable call. `stage` is 'hook' (first gate) or
     * 'final' (canUseTool, right after the hook allowed the same call).
     */
    check(name, input, stage = 'hook') {
      const key = actionKey(name, input)
      const a = approvals.get(key)
      const t = now()
      if (a && a.consumedAt !== undefined) {
        // The second gate for the call the hook just let through. A repeat of
        // the call meets a consumed approval at the hook and is refused.
        if (stage === 'final' && t - a.consumedAt < SECOND_GATE_MS) {
          approvals.delete(key)
          return { allow: true, reason: 'confirmed by Eli' }
        }
        approvals.delete(key)
      } else if (a && t < a.expires && stage === 'hook') {
        a.consumedAt = t
        return { allow: true, reason: 'confirmed by Eli' }
      } else if (a && t >= a.expires) {
        approvals.delete(key)
      }
      const summary = describeAction(name, input)
      pending.set(key, { name, summary, at: t })
      return {
        allow: false,
        confirm: summary,
        reason:
          `This needs Eli's spoken yes first. Read it back to him in your own voice, ` +
          `keeping every name, address, time and subject exactly: "${summary}". Then ask if you ` +
          `should go ahead, and stop. If he says yes, make exactly the same call again. ` +
          `If anything changes, it is a new action and needs a new yes.`,
      }
    },

    /** Eli spoke. Returns what it did to the pending actions. */
    onUserText(text) {
      const t = now()
      for (const [k, p] of pending) if (t - p.at > ttl) pending.delete(k)
      const waiting = [...pending.values()].map((p) => p.summary)
      if (waiting.length && isClearYes(text)) {
        approvals.clear()
        for (const k of pending.keys()) approvals.set(k, { expires: t + ttl })
        pending.clear()
        return { approved: waiting, cancelled: [] }
      }
      // Anything else cancels: pending actions and unused approvals alike.
      const cancelled = waiting.concat(approvals.size ? ['an approved action'] : [])
      pending.clear()
      approvals.clear()
      return { approved: [], cancelled }
    },

    noteRead(collection, docId, text) {
      if (typeof collection !== 'string' || typeof docId !== 'string') return
      reads.set(`${collection}/${docId}`, { text: String(text ?? ''), at: now() })
    },

    /** The text of a fresh read of this doc, or null. */
    readOf(collection, docId) {
      const r = reads.get(`${collection}/${docId}`)
      return r && now() - r.at < READ_FRESH_MS ? r.text : null
    },

    get pendingCount() {
      return pending.size
    },
  }
}
