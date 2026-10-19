import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'

/**
 * The `ui_*` tools — Jarvis's control of his own face.
 *
 * Donevia fork: trimmed to five tools (theme, reactor, effect, screen, reset)
 * and the palette is constrained to the Donevia brand tokens, so nothing the
 * model does can turn the face cyan or put a remote image on screen. The
 * upstream orbit and chrome tools are gone.
 *
 * `display` gives him a screen to put things on. This gives him the screen
 * itself: the colour the room is lit in, the size and temper of the reactor,
 * and the occasional flourish. The point is not decoration. An interface that
 * goes red before he says a word is carrying meaning faster than speech can — which is the whole reason a voice
 * assistant has a face at all.
 *
 * The descriptions below are the product. They are the only place the model
 * learns what the interface can be made to do and, more importantly, when it is
 * worth doing — so they are written as direction, not as parameter lists.
 *
 * Like panels.mjs this runs in-process, so a handler pushes straight down the
 * open WebSocket. Every handler emits exactly one message, matching the
 * bridge -> browser contract: { type: 'ui', op, args }.
 */

/**
 * Numbers and booleans arrive however the model felt like writing them — '0.5'
 * as a string, 1 for true, null for "leave it". A turn that fails because a
 * scale was quoted is a turn the user watched break, so nothing here rejects:
 * unions accept the loose forms, `.catch()` swallows the rest as absent, and
 * the handlers clamp into the ranges the browser expects. The worst outcome of
 * a bad value is that it is ignored.
 */
const looseNumber = (note) =>
  z.union([z.number(), z.string()]).optional().catch(undefined).describe(note)

const looseBool = (note) =>
  z
    .union([z.boolean(), z.string(), z.number()])
    .optional()
    .catch(undefined)
    .describe(note)

const FALSEY = new Set(['false', '0', 'no', 'off', 'hide', 'hidden', 'none'])

function clamp(value, lo, hi) {
  if (value === undefined || value === null) return undefined
  const n = typeof value === 'number' ? value : Number(String(value).trim())
  if (!Number.isFinite(n)) return undefined
  return Math.min(hi, Math.max(lo, n))
}

function toBool(value) {
  if (value === undefined || value === null) return undefined
  if (typeof value === 'boolean') return value
  if (typeof value === 'number') return value !== 0
  const s = String(value).trim().toLowerCase()
  if (!s) return undefined
  return !FALSEY.has(s)
}

/** Only real values reach the patch, so a deep merge never clears by accident. */
function put(target, key, value) {
  if (value !== undefined) target[key] = value
  return target
}

const has = (obj) => Object.keys(obj).length > 0

const ok = (text) => ({ content: [{ type: 'text', text }] })

/** The brand palette (SPEC 6.1). The model picks a token, never a raw colour. */
export const BRAND = {
  pink: '#FF2DAF',
  violet: '#9b6bff',
  amber: '#ffb547',
  red: '#ff5a6e',
  mint: '#6fe0b5',
}

const token = (note) =>
  z
    .enum(['pink', 'violet', 'amber', 'red', 'mint', 'auto'])
    .optional()
    .catch(undefined)
    .describe(note)

/** Token -> CSS colour; 'auto' -> null (follow the phase); absent -> undefined. */
const fromToken = (t) => (t === undefined ? undefined : t === 'auto' ? null : BRAND[t])

const themeSchema = {
  accent: token(
    'Override the phase colour everywhere: pink (Jarvis, needs you), violet (working, ' +
      'they owe), amber (due soon, stale), red (late, critical), mint (done). "auto" ' +
      'hands the interface back to its phase colours.',
  ),
}

const THEME_DESCRIPTION = `Retint the whole interface with one brand colour.

The face normally follows your state: pink while listening and speaking, violet
while thinking or reading data. An accent overrides that everywhere, at once.

Use it when the colour MEANS something: red because something is late, amber
because data is stale. Never in good news, never for decoration.

Do not redecorate for the sake of it, and do not leave a strange colour up after
the moment that earned it has passed — call \`ui_reset\` when it is over.

Never announce that you have done it. The user is looking at the screen.`

const reactorSchema = {
  color: token('The reactor core on its own. "auto" follows the accent and phase again.'),
  scale: looseNumber(
    'Size multiplier, 0.2 to 3, default 1. Below 1 the reactor recedes and the ' +
      'panels dominate; above 1.5 it owns the frame and everything else reads ' +
      'as trim.',
  ),
  intensity: looseNumber(
    'Glow and brightness, 0 to 3, default 1. 0.3 reads as a system on ' +
      'standby, 2 or more as strain — a hard computation, a warning, a surge.',
  ),
  spin: looseNumber(
    'Rotation-rate multiplier, 0 to 5, default 1. 0 stops it dead, which reads ' +
      'as powered down or frozen and is worth exactly one dramatic moment. 3 ' +
      'and up reads as effort.',
  ),
  style: z
    .enum(['orb', 'ring', 'sphere', 'wire'])
    .optional()
    .catch(undefined)
    .describe(
      'orb = the neutral glass-and-plasma orb, the default ("neutral orb"). ring = the halo ring ("ring"). sphere = a solid core, heavier and ' +
        'more present, good when you are the subject of the conversation. ' +
        'wire = a skeletal lattice, good for diagnostics, degraded states, and ' +
        'anything that should look like it is being taken apart.',
    ),
  visible: looseBool(
    'false removes the reactor entirely. Only when something else has earned ' +
      'the centre of the screen — a full-frame image the user is studying. ' +
      'Put it back the moment that is over.',
  ),
}

const REACTOR_DESCRIPTION = `Reshape the reactor at the centre of the display.

The reactor is you. It is the one element the user watches while they wait, so
its size, brightness and speed are read as your state whether you intend them to
be or not. Slowing it and dimming it says the system is idling; brightening and
speeding it says you are working hard on this.

Change one property at a time and mean it. A reactor that is huge, scarlet,
motionless and wireframed all at once is not a state, it is a mess.

Everything omitted stays as it is.`

const EFFECT_DESCRIPTION = `Fire a one-off effect across the interface.

  pulse = acknowledgement. Something landed: a command reached HQ, a deal moved.
  scan  = a sweep across the display while you read a lot of data.

At most one per turn, and only when something actually happened. An effect on
every answer is punctuation, and punctuation stops meaning anything by the third
sentence. Silence on the screen is the default, exactly as it is in your speech.`

const SCREEN_DESCRIPTION = `Clear the display.

  panels     = take down every card, including the sticky ones.
  transcript = wipe the conversation log.
  all        = both.

Use it when the user says clear the screen, or when a topic is finished and the
leftovers from the last one would confuse what comes next. It does not touch the
theme or the reactor — \`ui_reset\` does that.`

const RESET_DESCRIPTION = `Put the entire interface back to stock.

Colours and reactor — everything returns to the way it looks on a
fresh page. Panels and the transcript are left alone.

Call it when the user asks for normal, and call it yourself when whatever
justified a change is over. It is never the wrong thing to do.`

/**
 * @param {(op: string, args: object) => void} emit - pushes one ui message
 */
export function uiServer(emit) {
  return createSdkMcpServer({
    name: 'jarvis_ui',
    version: '1.0.0',
    instructions:
      'Jarvis\'s control of his own interface: colour, reactor, effects. ' +
      'Change it only when the change carries meaning, and put it back with ui_reset.',
    // Same reasoning as the display server: behind tool search it would never
    // occur to the model that the interface is something it can touch.
    alwaysLoad: true,
    tools: [
      tool('ui_theme', THEME_DESCRIPTION, themeSchema, async (args) => {
        const accent = fromToken(args.accent)
        if (accent === undefined) return ok('No change — no colour was given.')
        emit('patch', { accent })
        return ok('Interface retinted.')
      }),

      tool('ui_reactor', REACTOR_DESCRIPTION, reactorSchema, async (args) => {
        const reactor = {}
        put(reactor, 'color', fromToken(args.color))
        put(reactor, 'scale', clamp(args.scale, 0.2, 3))
        put(reactor, 'intensity', clamp(args.intensity, 0, 3))
        put(reactor, 'spin', clamp(args.spin, 0, 5))
        put(reactor, 'style', args.style)
        put(reactor, 'visible', toBool(args.visible))

        if (!has(reactor)) return ok('No change — no reactor properties were given.')
        emit('patch', { reactor })
        return ok('Reactor adjusted.')
      }),

      tool(
        'ui_effect',
        EFFECT_DESCRIPTION,
        {
          kind: z
            .enum(['pulse', 'scan'])
            .catch('pulse')
            .describe('Which effect to fire.'),
        },
        async (args) => {
          emit('effect', { kind: args.kind ?? 'pulse' })
          return ok('Fired.')
        },
      ),

      tool(
        'ui_screen',
        SCREEN_DESCRIPTION,
        {
          what: z
            .enum(['all', 'panels', 'transcript'])
            .default('all')
            .catch('all')
            .describe('What to clear.'),
        },
        async (args) => {
          const what = args.what ?? 'all'
          emit('screen', { what })
          return ok('Cleared.')
        },
      ),

      tool('ui_reset', RESET_DESCRIPTION, {}, async () => {
        emit('reset', {})
        return ok('Interface restored.')
      }),
    ],
  })
}
