/**
 * The Kokoro voices Jarvis offers, and the small pure rules around them.
 *
 * No imports, so the tests can load this file directly. The ids are the
 * best-graded English voices in kokoro-js's own list (Kokoro v1.0 grades in
 * brackets); bridge/env.mjs repeats the ids for the settings file, and a test
 * keeps the two lists equal.
 *
 * V cycles them in this order, live, starting from the one in use.
 */
export const KOKORO_VOICES = [
  { id: 'bf_emma', name: 'Emma', accent: 'British female' }, // B-, the default (Eli asked for a British woman)
  { id: 'bf_isabella', name: 'Isabella', accent: 'British female' }, // C
  { id: 'bm_george', name: 'George', accent: 'British male' }, // C, the butler
  { id: 'af_heart', name: 'Heart', accent: 'American female' }, // A, the best Kokoro voice
  { id: 'af_bella', name: 'Bella', accent: 'American female' }, // A-
  { id: 'am_michael', name: 'Michael', accent: 'American male' }, // C+
  { id: 'am_fenrir', name: 'Fenrir', accent: 'American male' }, // C+
  { id: 'af_nicole', name: 'Nicole', accent: 'American female' }, // B-, soft and close
  { id: 'am_puck', name: 'Puck', accent: 'American male' }, // C+
  { id: 'bm_fable', name: 'Fable', accent: 'British male' }, // C
  { id: 'bm_lewis', name: 'Lewis', accent: 'British male' }, // D+
  { id: 'bm_daniel', name: 'Daniel', accent: 'British male' }, // D
] as const

export type KokoroVoiceId = (typeof KOKORO_VOICES)[number]['id']

export const DEFAULT_KOKORO_VOICE: KokoroVoiceId = 'bf_emma'

export const KOKORO_VOICE_IDS: readonly string[] = KOKORO_VOICES.map((v) => v.id)

export const isKokoroVoice = (id: unknown): id is KokoroVoiceId =>
  typeof id === 'string' && KOKORO_VOICE_IDS.includes(id)

/** "George (British male)" for a known id, the id itself otherwise. */
export function voiceLabel(id: string): string {
  const v = KOKORO_VOICES.find((x) => x.id === id)
  return v ? `${v.name} (${v.accent})` : id
}

export const voiceName = (id: string): string => KOKORO_VOICES.find((x) => x.id === id)?.name ?? id

/** The voice after `id` in the cycle; the first one if `id` is unknown. */
export function nextVoice(id: string): KokoroVoiceId {
  const i = KOKORO_VOICE_IDS.indexOf(id)
  return KOKORO_VOICES[(i + 1) % KOKORO_VOICES.length].id
}

/**
 * The voice to use: a pick made with V, unless the settings file has changed
 * since that pick was made (then the settings file wins again), else the
 * settings file, else George.
 *
 * `saved` is what V stored: {"voice": picked, "base": settings voice then}.
 */
export function chooseVoice(settingsVoice: string, saved: string | null): KokoroVoiceId {
  const base = isKokoroVoice(settingsVoice) ? settingsVoice : DEFAULT_KOKORO_VOICE
  if (saved) {
    try {
      const s = JSON.parse(saved) as { voice?: unknown; base?: unknown }
      if (isKokoroVoice(s.voice) && s.base === base) return s.voice
    } catch {
      /* unreadable: ignore */
    }
  }
  return base
}

export const savedPick = (voice: string, settingsVoice: string): string =>
  JSON.stringify({ voice, base: isKokoroVoice(settingsVoice) ? settingsVoice : DEFAULT_KOKORO_VOICE })

/**
 * The HUD line shown while the Mac voice stands in for Kokoro, or '' when
 * Kokoro is speaking (or was never asked for).
 */
export function fallbackNote(k: {
  engine: 'kokoro' | 'system'
  state: 'idle' | 'loading' | 'ready' | 'failed' | 'slow'
  progress: number
  rtf: number
}): string {
  if (k.engine !== 'kokoro') return ''
  switch (k.state) {
    case 'ready':
      return ''
    case 'idle':
      return 'Mac voice: Kokoro not loaded yet'
    case 'loading': {
      const pct = Math.max(0, Math.min(99, Math.round(k.progress * 100)))
      return `Mac voice: Kokoro loading ${pct}%`
    }
    case 'slow':
      return `Kokoro too slow on this Mac (${k.rtf}x real time), using Mac voice`
    case 'failed':
      return 'Kokoro failed to load, using Mac voice (press D)'
  }
}
