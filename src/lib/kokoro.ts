/**
 * Kokoro: neural speech, entirely in this browser.
 *
 * An 82M-parameter TTS model running through ONNX in Chrome. No cloud, no key,
 * nothing Jarvis says leaves the Mac. The model downloads once from Hugging
 * Face (about 326 MB at fp32, 92 MB at q8) and is cached by Chrome after that.
 *
 * Device choice, in order (JARVIS_KOKORO_DEVICE=auto):
 *   1. WebGPU at fp32. kokoro-js recommends fp32 for WebGPU; upstream's q8 on
 *      WebGPU ran about 2.2x slower than real time, most likely because the
 *      int8 kernels fall back to the CPU.
 *   2. WASM at q8, if WebGPU is missing or fails to load.
 * If a generation run is consistently slower than real time, Jarvis stops
 * using Kokoro and speaks with the system voice instead; diagnostics (D)
 * show the measured speed.
 *
 * Forked from upstream's kokoro.ts: lazy load, progress, failure latch.
 */

import { runtime } from './runtime'
import { chooseVoice, isKokoroVoice, savedPick, fallbackNote, DEFAULT_KOKORO_VOICE } from './kokoroVoices'

type RawAudio = { audio?: Float32Array; sampling_rate?: number; toBlob: () => Blob }
type Kokoro = {
  generate: (text: string, opts: { voice: string; speed?: number }) => Promise<RawAudio>
  voices?: Record<string, unknown>
}

export { KOKORO_VOICES as VOICES } from './kokoroVoices'

const MODEL_ID = 'onnx-community/Kokoro-82M-v1.0-ONNX'

let model: Kokoro | null = null
let loading: Promise<Kokoro | null> | null = null
let failed = false
let progress = 0
/** Chosen with V; persisted per browser. See chooseVoice(). */
const PICK_KEY = 'jarvis.kokoroVoice'
let picked: string | null | undefined

function readPick(): string | null {
  if (picked !== undefined) return picked
  try {
    picked = localStorage.getItem(PICK_KEY)
  } catch {
    picked = null
  }
  return picked
}

/** Exposed on window.__kokoro for the diagnostics panel. */
export const diag = {
  state: 'idle' as 'idle' | 'loading' | 'ready' | 'failed' | 'slow',
  device: '',
  dtype: '',
  voice: '',
  progress: 0,
  loadMs: 0,
  /** Generation time / audio duration, averaged. Under 1 is faster than real time. */
  rtf: 0,
  generated: 0,
  lastError: '',
}
if (typeof window !== 'undefined') (window as unknown as Record<string, unknown>).__kokoro = diag

export const loadProgress = () => progress

/** Why the Mac voice is speaking instead of Kokoro, for the HUD; '' if it isn't. */
export const fallback = (): string =>
  fallbackNote({ engine: runtime().tts.engine, state: diag.state, progress: diag.progress, rtf: diag.rtf })
export const isReady = () => model !== null && !failed
export const isUnavailable = () => failed
/** The voice in use now: a pick made with V, else the settings file. Read on
 *  every sentence, so a change applies to the next one without a restart. */
export const activeVoice = (): string => chooseVoice(runtime().tts.voice, readPick())

/** Switch voice live and remember it in this browser. */
export function setVoice(id: string): string {
  if (!isKokoroVoice(id)) return activeVoice()
  picked = savedPick(id, runtime().tts.voice)
  try {
    localStorage.setItem(PICK_KEY, picked)
  } catch {
    /* private window: the pick lasts until reload */
  }
  diag.voice = id
  return id
}
export let lastError = ''

const MAX_FAILURES = 3
let failures = 0

/** Real-time factor above which Kokoro is too slow to converse with. */
const SLOW_RTF = 1.4
const rtfs: number[] = []
/** The first sentence in a voice also downloads that voice (about 0.5 MB), so
 *  it is not counted towards the speed check. */
let measuredVoice = ''

function plans(): Array<{ device: 'webgpu' | 'wasm'; dtype: 'fp32' | 'q8' }> {
  const want = runtime().tts.device
  const hasGpu = typeof navigator !== 'undefined' && 'gpu' in navigator
  if (want === 'wasm') return [{ device: 'wasm', dtype: 'q8' }]
  if (want === 'webgpu') return [{ device: 'webgpu', dtype: 'fp32' }]
  return hasGpu
    ? [{ device: 'webgpu', dtype: 'fp32' }, { device: 'wasm', dtype: 'q8' }]
    : [{ device: 'wasm', dtype: 'q8' }]
}

export async function load(): Promise<Kokoro | null> {
  if (model) return model
  if (failed) return null
  if (loading) return loading

  diag.voice = activeVoice()
  diag.state = 'loading'
  const t0 = performance.now()

  loading = (async () => {
    // Ask Chrome to keep the cached model when disk space runs low.
    try {
      await navigator.storage?.persist?.()
    } catch {
      /* not granted; Chrome may still keep it */
    }
    const { KokoroTTS } = await import('kokoro-js')
    let lastErr: unknown = null
    for (const plan of plans()) {
      try {
        const tts = (await KokoroTTS.from_pretrained(MODEL_ID, {
          dtype: plan.dtype,
          device: plan.device,
          progress_callback: (p: unknown) => {
            const pct = (p as { progress?: number })?.progress
            if (typeof pct === 'number') {
              progress = pct / 100
              diag.progress = progress
            }
          },
        })) as unknown as Kokoro
        progress = 1
        diag.progress = 1
        diag.device = plan.device
        diag.dtype = plan.dtype
        diag.voice = activeVoice()
        diag.state = 'ready'
        diag.loadMs = Math.round(performance.now() - t0)
        model = tts
        console.info(`[jarvis] Kokoro ready on ${plan.device}/${plan.dtype} in ${diag.loadMs} ms`)
        return model
      } catch (err) {
        lastErr = err
        console.warn(`[jarvis] Kokoro ${plan.device}/${plan.dtype} failed:`, err)
      }
    }
    lastError = String((lastErr as Error)?.message ?? lastErr)
    diag.lastError = lastError
    diag.state = 'failed'
    failed = true
    return null
  })().finally(() => {
    loading = null
  })

  return loading
}

/** Speak only if the model is already loaded; never waits on the download. */
export function speakIfReady(text: string): Promise<string | null> {
  if (!model || failed) return Promise.resolve(null)
  return speak(text)
}

/** Synthesise one sentence to a blob URL. Null if Kokoro is not usable. */
export async function speak(text: string): Promise<string | null> {
  const tts = await load()
  if (!tts) return null
  try {
    const t0 = performance.now()
    // A voice this kokoro-js build does not carry would throw on every
    // sentence; use the default instead.
    let voice = activeVoice()
    if (tts.voices && !(voice in tts.voices)) voice = DEFAULT_KOKORO_VOICE
    diag.voice = voice
    const audio = await tts.generate(text, { voice, speed: 1.0 })
    const genS = (performance.now() - t0) / 1000
    const durS = audio.audio && audio.sampling_rate ? audio.audio.length / audio.sampling_rate : 0
    const firstInVoice = voice !== measuredVoice
    measuredVoice = voice
    if (durS > 0.3 && !firstInVoice) {
      rtfs.push(genS / durS)
      if (rtfs.length > 6) rtfs.shift()
      diag.rtf = Math.round((rtfs.reduce((a, b) => a + b, 0) / rtfs.length) * 100) / 100
      // Three measured sentences, all too slow: this Mac cannot keep up, so
      // the system voice takes over rather than leaving gaps between sentences.
      if (rtfs.length >= 3 && diag.rtf > SLOW_RTF) {
        failed = true
        diag.state = 'slow'
        lastError = `too slow on ${diag.device}/${diag.dtype} (${diag.rtf}x real time)`
        diag.lastError = lastError
        console.warn(`[jarvis] Kokoro ${lastError}; using the system voice.`)
      }
    }
    diag.generated++
    failures = 0
    return URL.createObjectURL(audio.toBlob())
  } catch (err) {
    console.error('[jarvis] Kokoro generation failed:', err)
    lastError = String((err as Error)?.message ?? err)
    diag.lastError = lastError
    failures++
    if (failures >= MAX_FAILURES) {
      failed = true
      diag.state = 'failed'
      console.warn(`[jarvis] Kokoro failed ${failures} times running; using the system voice.`)
    }
    return null
  }
}
