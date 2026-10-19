/**
 * Earcons, synthesised in Web Audio. No audio files, so nothing to license.
 *
 * Tuned to HQ's sound rules (SPEC 6.6): master gain 0.15, every partial between
 * 150 Hz and 5 kHz, notes at least 30 ms, and everything ducks to 30% under
 * Jarvis's voice. Upstream's music tracks and ambient bed are gone: two of the
 * three files contradicted their credits, and a room tone is not something a
 * founder wants humming under a call.
 */

type Cue = 'boot' | 'wake' | 'listen' | 'tool' | 'done' | 'error'

let ctx: AudioContext | null = null
let master: GainNode | null = null

const VOLUME = 0.15
const DUCK = 0.3
let ducked = false

function audio(): AudioContext {
  if (!ctx) {
    ctx = new AudioContext()
    master = ctx.createGain()
    master.gain.value = VOLUME
    master.connect(ctx.destination)
  }
  return ctx
}

function rampTo(param: AudioParam, to: number, seconds: number) {
  if (!ctx) return
  const now = ctx.currentTime
  param.cancelScheduledValues(now)
  param.setValueAtTime(param.value, now)
  param.linearRampToValueAtTime(Math.max(0.0001, to), now + seconds)
}

/** Must be called from a click or key press. Never throws. */
export async function unlockAudio(): Promise<void> {
  const c = audio()
  if (c.state === 'suspended') {
    try {
      await c.resume()
    } catch {
      /* a silent start is better than a failed one */
    }
  }
}

const clampHz = (f: number) => Math.min(5000, Math.max(150, f))

/** One soft note: sine or triangle, fast attack, exponential tail. */
function note(freq: number, { at = 0, dur = 0.12, type = 'sine' as OscillatorType, gain = 0.5, glide = 0 } = {}) {
  const c = audio()
  const t = c.currentTime + at
  const osc = c.createOscillator()
  const env = c.createGain()
  osc.type = type
  osc.frequency.setValueAtTime(clampHz(freq), t)
  if (glide) osc.frequency.exponentialRampToValueAtTime(clampHz(glide), t + dur)
  const d = Math.max(0.03, dur)
  env.gain.setValueAtTime(0.0001, t)
  env.gain.exponentialRampToValueAtTime(gain, t + Math.min(0.02, d / 3))
  env.gain.exponentialRampToValueAtTime(0.0001, t + d)
  osc.connect(env).connect(master!)
  osc.start(t)
  osc.stop(t + d + 0.05)
}

/** Band-limited noise swell, for the boot sweep. */
function air({ at = 0, dur = 1.2, gain = 0.12, from = 300, to = 3200 } = {}) {
  const c = audio()
  const t = c.currentTime + at
  const frames = Math.floor(c.sampleRate * dur)
  const buf = c.createBuffer(1, frames, c.sampleRate)
  const data = buf.getChannelData(0)
  for (let i = 0; i < frames; i++) data[i] = Math.random() * 2 - 1
  const src = c.createBufferSource()
  src.buffer = buf
  const bp = c.createBiquadFilter()
  bp.type = 'bandpass'
  bp.Q.value = 1.4
  bp.frequency.setValueAtTime(clampHz(from), t)
  bp.frequency.exponentialRampToValueAtTime(clampHz(to), t + dur)
  const env = c.createGain()
  env.gain.setValueAtTime(0.0001, t)
  env.gain.exponentialRampToValueAtTime(gain, t + dur * 0.6)
  env.gain.exponentialRampToValueAtTime(0.0001, t + dur)
  src.connect(bp).connect(env).connect(master!)
  src.start(t)
  src.stop(t + dur + 0.05)
}

const synth: Record<Cue, () => void> = {
  // Under two seconds: a rising air sweep that resolves on a soft major sixth.
  boot: () => {
    air({ dur: 1.4, gain: 0.16, from: 220, to: 2600 })
    note(196, { dur: 1.6, type: 'triangle', gain: 0.22, glide: 392 })
    note(587, { at: 1.2, dur: 0.5, gain: 0.3 })
    note(988, { at: 1.32, dur: 0.7, gain: 0.26 })
  },
  wake: () => {
    note(784, { dur: 0.08, gain: 0.4 })
    note(1175, { at: 0.11, dur: 0.14, gain: 0.36 })
  },
  listen: () => note(660, { dur: 0.08, gain: 0.3 }),
  tool: () => note(1568, { dur: 0.04, type: 'triangle', gain: 0.18 }),
  done: () => {
    note(1047, { dur: 0.08, gain: 0.26 })
    note(784, { at: 0.12, dur: 0.16, gain: 0.24 })
  },
  // Different rhythm, not louder: two low even notes.
  error: () => {
    note(330, { dur: 0.14, type: 'triangle', gain: 0.4 })
    note(247, { at: 0.24, dur: 0.22, type: 'triangle', gain: 0.4 })
  },
}

export function play(cue: Cue) {
  if (!ctx || ctx.state !== 'running') return
  if (typeof document !== 'undefined' && document.hidden) return
  synth[cue]()
}

/** Duck to 30% while Jarvis speaks. Down fast, back slowly. */
export function duck(on: boolean) {
  if (ducked === on || !master) return
  ducked = on
  rampTo(master.gain, on ? VOLUME * DUCK : VOLUME, on ? 0.12 : 0.5)
}
