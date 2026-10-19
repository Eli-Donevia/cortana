import { randomBytes } from 'node:crypto'
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import { COMMAND_COLLECTION, COMMAND_EXAMPLES, commandIntent, normalizeCommand } from './policy.mjs'

/**
 * Jarvis's screen, and the helper for driving HQ.
 *
 * Two in-process tools (an SDK MCP server, so handlers push straight down the
 * open WebSocket):
 *   display     the model composes a small card in the .hud-* design system;
 *               it opens as a blade beside the reactor. Text only: no images,
 *               video or iframes, so a panel can never fetch anything remote.
 *   hq_command  a helper that checks the command is one of HQ's display
 *               intents, then returns a fresh command id, a timestamp and the
 *               exact ArtifactData call that queues it in HQ. It writes
 *               nothing itself; the model makes the call and the policy gate
 *               checks it again, including that the id came from here.
 */

const DESIGN_SYSTEM = `
LAYOUT CLASSES. Compose these and nothing else; any other class is stripped.
  .hud-rows     vertical list container
  .hud-row      one row: put .hud-idx, .hud-main, .hud-tag inside
  .hud-idx      leading index, dim and monospaced
  .hud-main     the row's text column
  .hud-label    primary line (clamped to 2 lines)
  .hud-sub      secondary line, dimmed
  .hud-tag      small trailing tag, right-aligned (a stage, a date, a count)
  .hud-metric   huge numeral, for one headline figure
  .hud-unit     small caption under a metric
  .hud-note     a short passage of prose
  .hud-grid     two-column grid
  .hud-bar      thin progress bar; style="--v:0.62" for 62%
  .hud-dim      de-emphasise
  .hud-hot      emphasise (the pink "needs you" colour; use sparingly)

RULES
  - Text only. No <img>, <video>, <iframe>, <style>, <script>, links or handlers.
  - No inline colours. Use the accent argument.
  - Every panel needs visible text; an empty body is refused.
  - About 6 rows or 40 words. It is glanced at while Eli listens.

EXAMPLES
Things that need Eli:
<div class="hud-rows">
  <div class="hud-row"><span class="hud-idx">01</span><span class="hud-main"><span class="hud-label">Send NOFFCU the preliminary LOI</span><span class="hud-sub">You owe it · due Friday</span></span><span class="hud-tag">owed</span></div>
  <div class="hud-row"><span class="hud-idx">02</span><span class="hud-main"><span class="hud-label">Decide Money 20/20 or JHA Connect</span></span><span class="hud-tag">today</span></div>
</div>

A single figure:
<div><span class="hud-metric">7</span><span class="hud-unit">credit unions in active pipeline</span></div>
`.trim()

const schema = {
  title: z.string().describe('Two to four words, e.g. "NEEDS YOU", "PIPELINE", "NEXT MEETING".'),
  html: z.string().describe('The panel body as an HTML fragment in the design system below.'),
  slot: z
    .enum(['right', 'wide'])
    .default('right')
    .catch('right')
    .describe('right = compact card beside the reactor. wide = broader card for a small table.'),
  accent: z
    .enum(['default', 'violet', 'amber', 'red', 'mint'])
    .default('default')
    .catch('default')
    .describe(
      'default = Donevia pink. violet = in progress or "they owe". amber = due soon or stale. ' +
        'red = late or critical. mint = done, only in looking-back views.',
    ),
  hold: z
    .enum(['turn', 'sticky'])
    .default('turn')
    .catch('turn')
    .describe('turn = clears when Eli next speaks. sticky = stays until replaced.'),
}

const DESCRIPTION = `Put a card on the Jarvis display beside the reactor.

Use it whenever the answer has substance worth seeing: the items you named, a short
list of deals or meetings, a figure. Call it BEFORE you speak. Never read it aloud.

${DESIGN_SYSTEM}`

const HQ_DESCRIPTION = `Prepare a command for Donevia HQ to run on its wall, desk or phone view.

Returns a fresh command id, a timestamp and the exact database call to make. This
tool writes nothing; make the returned call unchanged right after it. Use it when
Eli wants something shown on HQ: "put the pipeline on the wall", "brief me on HQ".

Only these commands exist: ${COMMAND_EXAMPLES}. Anything else is refused.`

const hqSchema = {
  text: z
    .string()
    .describe(
      'One HQ display command, e.g. "show pipeline", "brief me", "what\'s next", ' +
        '"what do I owe", "where are we with NOFFCU", "fly to NOFFCU", "wall mode".',
    ),
}

let seq = 0

/** "jv" + 16 lowercase hex characters, which the policy gate accepts. */
export const newCommandId = () => `jv${randomBytes(8).toString('hex')}`

/**
 * Map a near miss onto an HQ display command: "focus NOFFCU" or "open NOFFCU"
 * becomes "where are we with noffcu". Returns null if nothing fits.
 */
export function toHqCommand(text) {
  const direct = commandIntent(text)
  if (direct) return direct
  const t = normalizeCommand(text)
    .replace(/ (?:on|to|in) (?:hq|the wall|the screen|the display)$/, '')
    .replace(/^(show|open|pull up|put) (?:me )?(?:the |my )?/, 'show ')
    .replace(/^show (pipeline|build|backlog|partners|events)(?: up)?$/, 'show $1')
  const again = commandIntent(t)
  if (again) return again
  const m = /^(?:focus(?: on)?|show) (.+)$/.exec(t)
  return m ? commandIntent(`where are we with ${m[1]}`) : null
}

/**
 * The call the model should make for one HQ command.
 * `hqTool` is 'ArtifactData' or 'Artifact' (write_db).
 */
export function commandCall({ text, hqUrl, hqTool = 'ArtifactData', id = newCommandId(), now = new Date() }) {
  const data = {
    id,
    text,
    at: now.toISOString(),
    from: 'companion',
    status: 'new',
    // HQ shows the result without speaking it: Jarvis has already answered.
    quiet: true,
  }
  const input =
    hqTool === 'Artifact'
      ? { action: 'write_db', db_op: 'set', url: hqUrl, collection: COMMAND_COLLECTION, doc_id: id, data }
      : { action: 'set', url: hqUrl, collection: COMMAND_COLLECTION, doc_id: id, data }
  return { tool: hqTool, input }
}

/**
 * @param {object} p
 * @param {(blade: object) => void} p.emitBlade   pushes a card to the browser
 * @param {string} p.hqUrl
 * @param {() => string} p.hqTool                 which database tool this session has
 * @param {(id: string, text: string) => void} [p.onIssue]  records each command id and its text
 */
export function displayServer({ emitBlade, hqUrl, hqTool, onIssue = () => {} }) {
  return createSdkMcpServer({
    name: 'jarvis',
    version: '2.0.0',
    instructions: 'The Donevia Jarvis display. Use `display` to put content on screen alongside what you say.',
    // Never behind tool search: if the model has to look for it, it won't show anything.
    alwaysLoad: true,
    tools: [
      tool('display', DESCRIPTION, schema, async (args) => {
        const html = String(args.html ?? '')
        const text = html.replace(/<[^>]*>/g, '').trim()
        if (!text) {
          return refuse('Not shown: the panel body was empty. Call display again with text in html.')
        }
        emitBlade({
          id: `p${Date.now().toString(36)}-${(seq++).toString(36)}`,
          title: String(args.title ?? '').trim() || 'DISPLAY',
          kind: 'markup',
          html,
          accent: args.accent ?? 'default',
          size: args.slot === 'wide' ? 'wide' : 'compact',
          hold: args.hold ?? 'turn',
        })
        return { content: [{ type: 'text', text: 'On screen.' }] }
      }),

      tool('hq_command', HQ_DESCRIPTION, hqSchema, async (args) => {
        const text = toHqCommand(String(args.text ?? ''))
        if (!text) {
          return refuse(
            `HQ has no display command for that. Only these work: ${COMMAND_EXAMPLES}. ` +
              'If none fits, answer Eli here instead.',
          )
        }
        const call = commandCall({ text, hqUrl, hqTool: hqTool() })
        onIssue(call.input.doc_id, text)
        return {
          content: [
            {
              type: 'text',
              text:
                `Now call ${call.tool} with exactly this input, then say one short line such as "On the wall.":\n` +
                JSON.stringify(call.input),
            },
          ],
        }
      }),
    ],
  })
}

const refuse = (text) => ({ isError: true, content: [{ type: 'text', text }] })
