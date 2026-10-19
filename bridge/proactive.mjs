/**
 * Cortana speaking first: a nudge five minutes before each meeting, and an
 * alert only for things that matter (a Docusign envelope completed, an email
 * from someone in the pipeline). The morning brief lives in the face: it asks
 * for one on the first open of the day.
 *
 * Checks run as short read-only background sessions on the fast model (the
 * same runner and gate as agents, with every action refused), for the active
 * workspace only:
 *   - the day's remaining meetings, refreshed every hour;
 *   - alerts, every JARVIS_ALERT_MINUTES (default 20).
 *
 * Quiet rules: the face only ever speaks while Eli is not talking and she is
 * idle; during quiet hours (JARVIS_QUIET_HOURS, default 22:30-07:00 Central)
 * and while snoozed ("not now", one hour) notices are shown, not spoken.
 *
 * The scheduling helpers are pure, so test/proactive.test.mjs covers them.
 */

export const NUDGE_LEAD_MS = 5 * 60_000
export const SNOOZE_MS = 60 * 60_000

/** The first JSON array in a model's reply, or []. */
export function parseJsonArray(text) {
  const s = String(text ?? '')
  const i = s.indexOf('[')
  const j = s.lastIndexOf(']')
  if (i < 0 || j <= i) return []
  try {
    const v = JSON.parse(s.slice(i, j + 1))
    return Array.isArray(v) ? v : []
  } catch {
    return []
  }
}

/** Minutes since midnight in Chicago for a Date. */
export function chicagoMinutes(now) {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', hour: 'numeric', minute: 'numeric', hourCycle: 'h23' }).formatToParts(now)
  const h = Number(parts.find((p) => p.type === 'hour')?.value ?? 0)
  const m = Number(parts.find((p) => p.type === 'minute')?.value ?? 0)
  return h * 60 + m
}

/** "22:30-07:00" -> is `now` inside it (Chicago time)? An empty or bad spec is never quiet. */
export function inQuietHours(now, spec) {
  const m = /^(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})$/.exec(String(spec ?? '').trim())
  if (!m) return false
  const a = Number(m[1]) * 60 + Number(m[2])
  const b = Number(m[3]) * 60 + Number(m[4])
  const t = chicagoMinutes(now)
  return a <= b ? t >= a && t < b : t >= a || t < b
}

/**
 * Meetings worth a nudge: valid start, still ahead of the lead time, not seen
 * before. Returns [{ key, at, line }], `at` being when to speak.
 */
export function planNudges(events, now, seen = new Set()) {
  const out = []
  for (const e of Array.isArray(events) ? events : []) {
    const start = Date.parse(e?.start)
    const title = String(e?.title ?? '').trim().slice(0, 80) || 'a meeting'
    if (!Number.isFinite(start)) continue
    const at = start - NUDGE_LEAD_MS
    const key = `${title}@${start}`
    if (seen.has(key) || at < now - 60_000) continue
    const who = Array.isArray(e.attendees) ? e.attendees.filter(Boolean).slice(0, 3).join(', ') : ''
    out.push({ key, at: Math.max(at, now), line: `${title} starts in five minutes${who ? `, with ${who}` : ''}. Want the prep?` })
  }
  return out
}

/** Alerts from a check, cleaned: at most three, each a short spoken line. */
export function cleanAlerts(list, seen = new Set()) {
  const out = []
  for (const a of Array.isArray(list) ? list : []) {
    const line = String(a?.line ?? '').replace(/\s+/g, ' ').trim().slice(0, 220)
    const key = String(a?.key ?? line).slice(0, 200)
    if (!line || seen.has(key)) continue
    out.push({ key, line })
    if (out.length === 3) break
  }
  return out
}

/** "Not now", "quiet for an hour", "snooze" / "you can talk again". */
export function quietCommand(text) {
  const t = String(text ?? '')
    .toLowerCase()
    .replace(/^(?:hey |ok |okay )?(?:cortana|kortana)[ ,.]*/, '')
    .replace(/[.!?]+$/, '')
    .trim()
  if (/^(?:not now|quiet(?: for (?:an|one|1) hour)?|snooze(?: for (?:an|one|1) hour)?|no interruptions|give me (?:an hour|some quiet)|hold (?:my|the) alerts)$/.test(t)) return 'snooze'
  if (/^(?:you can talk again|unsnooze|alerts on|i'm back|im back)$/.test(t)) return 'unsnooze'
  return null
}

export function meetingsPrompt(ws) {
  return `List Eli's calendar events from now until the end of today, Central time${
    ws.calendars?.length ? `, on these calendars only: ${ws.calendars.join(', ')}` : ''
  }. Use the calendar tool once. Reply with ONLY a JSON array, no other text:
[{"title": "...", "start": "ISO 8601 with offset", "attendees": ["first names"]}]
Skip all-day events and events Eli declined. Reply [] if there are none.`
}

export function alertsPrompt(ws, sinceIso) {
  const checks = []
  if (ws.services.includes('docusign')) checks.push('Docusign envelopes that were completed (fully signed)')
  if (ws.services.includes('gmail')) {
    checks.push(
      `new emails in the inbox${ws.gmailQuery ? ` matching "${ws.gmailQuery}"` : ''} from people Eli is actively doing deals or partnerships with` +
        (ws.hqUrl ? ' (the people in HQ pipeline and partners)' : ws.services.includes('attio') ? ' (people on open Attio deals)' : ''),
    )
  }
  if (!checks.length) return null
  return `Check for things since ${sinceIso} that are worth interrupting Eli for: ${checks.join('; and ')}.
Newsletters, receipts, notifications and cold outreach never count. Only real, time-sensitive things.
Reply with ONLY a JSON array, at most 3 items, no other text:
[{"key": "a stable id such as the message or envelope id", "line": "one short spoken sentence, e.g. Shirley at NOFFCU just signed the pilot agreement."}]
Reply [] if nothing qualifies, which is the usual answer.`
}

/**
 * The scheduler. `run(prompt, ws)` runs one read-only check and resolves to
 * its text; `notify({ line, kind })` hands a notice to the face.
 */
export function createProactive({ activeWorkspace, run, notify, now = () => Date.now(), quietHours = '22:30-07:00', alertMinutes = 20, enabled = true }) {
  const nudgeSeen = new Set()
  const alertSeen = new Set()
  const timers = new Map()
  let snoozedUntil = 0
  let lastAlertCheck = new Date(now() - 30 * 60_000).toISOString()
  let meetingTimer = null
  let alertTimer = null
  let busy = false

  const quiet = () => now() < snoozedUntil || inQuietHours(new Date(now()), quietHours)
  const say = (line, kind) => notify({ line, kind, speak: !quiet() })

  async function refreshMeetings() {
    const ws = activeWorkspace()
    if (!enabled || !ws?.services.includes('calendar')) return
    try {
      const events = parseJsonArray(await run(meetingsPrompt(ws), ws))
      for (const n of planNudges(events, now(), nudgeSeen)) {
        nudgeSeen.add(n.key)
        const t = setTimeout(() => {
          timers.delete(n.key)
          say(n.line, 'meeting')
        }, Math.max(0, n.at - now()))
        t.unref?.()
        timers.set(n.key, t)
      }
    } catch (err) {
      console.warn(`[jarvis] meeting check failed: ${err?.message ?? err}`)
    }
  }

  async function checkAlerts() {
    const ws = activeWorkspace()
    if (!enabled || busy || !ws) return
    const prompt = alertsPrompt(ws, lastAlertCheck)
    if (!prompt) return
    busy = true
    const startedAt = new Date(now()).toISOString()
    try {
      for (const a of cleanAlerts(parseJsonArray(await run(prompt, ws)), alertSeen)) {
        alertSeen.add(a.key)
        say(a.line, 'alert')
      }
      lastAlertCheck = startedAt
    } catch (err) {
      console.warn(`[jarvis] alert check failed: ${err?.message ?? err}`)
    } finally {
      busy = false
    }
  }

  return {
    start() {
      if (!enabled || meetingTimer) return
      void refreshMeetings()
      meetingTimer = setInterval(refreshMeetings, 60 * 60_000)
      meetingTimer.unref?.()
      alertTimer = setInterval(checkAlerts, Math.max(5, alertMinutes) * 60_000)
      alertTimer.unref?.()
    },
    stop() {
      clearInterval(meetingTimer)
      clearInterval(alertTimer)
      meetingTimer = alertTimer = null
      for (const t of timers.values()) clearTimeout(t)
      timers.clear()
    },
    /** A workspace switch: drop the old company's nudges and look again. */
    reset() {
      for (const t of timers.values()) clearTimeout(t)
      timers.clear()
      nudgeSeen.clear()
      if (meetingTimer) void refreshMeetings()
    },
    snooze(ms = SNOOZE_MS) {
      snoozedUntil = now() + ms
    },
    unsnooze() {
      snoozedUntil = 0
    },
    isQuiet: quiet,
    /** For tests. */
    refreshMeetings,
    checkAlerts,
    pendingNudges: () => timers.size,
  }
}
