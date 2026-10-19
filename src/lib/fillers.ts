/**
 * The short lines Jarvis says on his own: answering to his name, and one
 * filler while a slow tool runs, so silence never reads as a crash. HQ house
 * style: plain, addressed to Eli, no "sir", no enthusiasm. Rotated so the
 * same line never comes twice in a row.
 */

const ATTENTION = ['Yes, Eli?', 'Eli.', 'Go ahead.', 'Listening.', "I'm here."]

const WORKING = ['One moment.', 'Checking.', 'Looking now.']

function makePicker(pool: string[]) {
  let last = -1
  return () => {
    if (pool.length < 2) return pool[0] ?? ''
    let i = last
    while (i === last) i = Math.floor(Math.random() * pool.length)
    last = i
    return pool[i]
  }
}

export const attention = makePicker(ATTENTION)
export const working = makePicker(WORKING)

type Rule = { test: RegExp; lines: string[] }

/** Matched against the raw tool name plus its badge ("HQ · pipeline"). */
const BY_TOOL: Rule[] = [
  { test: /Thinking deeper/, lines: ['Give me a minute on this one.', 'Let me think that through.', 'Digging in.'] },
  { test: /HQ · command/, lines: ['Sending it to HQ.', 'Putting it on HQ.'] },
  { test: /HQ · (pipeline|partners)/, lines: ['Checking the pipeline.', 'Pulling the pipeline.'] },
  { test: /HQ · (attention|commitments)/, lines: ['Checking the queue.', 'Looking at what you owe.'] },
  { test: /HQ · prep/, lines: ['Pulling the prep.', 'Getting the prep notes.'] },
  { test: /HQ ·/, lines: ['Checking HQ.', 'Looking in HQ.'] },
  { test: /Gmail|mail/i, lines: ['Checking your mail.', 'Looking in Gmail.'] },
  { test: /Calendar|event/i, lines: ['Checking your calendar.'] },
  { test: /Granola|meeting/i, lines: ['Pulling the meeting notes.', 'Checking Granola.'] },
  { test: /Notion/i, lines: ['Checking Notion.'] },
  { test: /Attio|record/i, lines: ['Checking Attio.', 'Looking at the CRM.'] },
  { test: /Drive|file/i, lines: ['Searching Drive.'] },
]

const pickers = new Map<Rule, () => string>()

/** One spoken filler for a tool that has just started. */
export function forTool(label: string, raw = ''): string {
  const hay = `${label} ${raw}`
  for (const rule of BY_TOOL) {
    if (rule.test.test(hay)) {
      if (!pickers.has(rule)) pickers.set(rule, makePicker(rule.lines))
      return pickers.get(rule)!()
    }
  }
  return working()
}
