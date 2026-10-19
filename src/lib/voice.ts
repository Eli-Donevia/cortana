import { getMic } from './audio'
import { speakingNow } from './tts'
import { startPorcupine, type Porcupine } from './porcupine'
import { WAKE, wakeVerdict } from './wake'

/**
 * The voice loop.
 *
 * One recogniser, running for the life of the page. It is never torn down for
 * a turn, and that single fact is most of what separates this from a kiosk:
 * the microphone is still open while JARVIS is talking, so you can cut him off
 * the way you would cut off a person.
 *
 * The obvious design — one recogniser hunting for the wake word, a second one
 * capturing the command, stopping the first to start the second because the
 * browser only hands out one at a time — is what this replaces. It works, but
 * nothing is listening during an answer, so barge-in is impossible, and every
 * restart leaves a quarter-second of deafness that eats whole wake words.
 *
 * Keeping the mic open costs one thing: JARVIS hears himself through the
 * speakers. That is handled here in text rather than in acoustics — see
 * `isEcho` — because the browser gives SpeechRecognition its own capture and
 * won't let us put a canceller in front of it.
 */

export type VoiceMode =
  /** Powered down. Only his name matters. */
  | 'wake'
  /** He is expecting you to speak. Everything is a command. */
  | 'command'
  /** He is thinking or talking. Anything you say is an interruption. */
  | 'guard'
  /** Something is playing that must not be transcribed at all. */
  | 'deaf'

export type VoiceHandlers = {
  /** Read fresh on every result, so the app never has to re-subscribe. */
  mode: () => VoiceMode
  /** Fired on his name — from a partial, or from Porcupine — since waiting for endpointing feels slow.
   *  `trailing` is whatever followed it, so "Jarvis, what's the weather" is
   *  one breath rather than two turns. */
  onWake: (trailing: string) => void
  /** The user has genuinely started talking. This is the barge-in trigger. */
  onSpeechStart: () => void
  /** Live transcript, for the caption under the reactor. */
  onPartial: (text: string) => void
  /** A complete, endpointed utterance. */
  onUtterance: (text: string) => void
  /** The recogniser is unusable. Distinct from the user saying nothing. */
  onError: (message: string) => void
  /** How the wake word is heard changed after start (the speech pack arrived). */
  onWakeChange?: (wake: string) => void
}

export type Voice = {
  stop: () => void
  /** True while a recogniser is actually running. */
  live: () => boolean
  /** Start the recogniser now rather than on the next mode poll (push-to-talk). */
  kick?: () => void
}

// ---------------------------------------------------------------------------
// Endpointing
// ---------------------------------------------------------------------------

/** One utterance often produces several partials containing his name. */
const WAKE_DEBOUNCE = 3000

/**
 * His name, and the only wake phrase.
 *
 * The optional prefix is genuinely optional: addressing him by name alone is
 * correct, and during an answer "Jarvis" on its own is the natural way to cut
 * in. The negative lookahead keeps possessives ("Jarvis's job") from waking him.
 *
 * The alternates are not padding. "Jarvis" is not in a general dictation
 * model's high-frequency vocabulary, and Chrome routinely returns Travis,
 * Jervis, Jarvys or Java's for a perfectly clear utterance — every one of which
 * used to be silently discarded, so the wake word "just didn't work" with no
 * indication why. Better a rare false wake than a name that does not answer.
 */
// -- the wake-word switch ----------------------------------------------------
// W, the footer toggle, or "stop listening for your name". Remembered in this
// browser, so it survives a restart.
const WAKE_PREF_KEY = 'cortana.wakeWord'
let wakeEnabled = (() => {
  try {
    return localStorage.getItem(WAKE_PREF_KEY) !== 'off'
  } catch {
    return true
  }
})()
export const wakeWordEnabled = () => wakeEnabled
export function setWakeWordEnabled(on: boolean) {
  wakeEnabled = on
  diag.wakeOff = !on
  try {
    localStorage.setItem(WAKE_PREF_KEY, on ? 'on' : 'off')
  } catch {
    /* private window: just this session */
  }
}

/** Everything after the wake phrase, which is usually the actual command. */
function afterWake(text: string): string {
  const m = WAKE.exec(text)
  if (!m) return ''
  return text
    .slice(m.index + m[0].length)
    .replace(/^[\s,.:;!?-]+/, '')
    .trim()
}

// ---------------------------------------------------------------------------
// Assembling one utterance out of several segments
// ---------------------------------------------------------------------------

/**
 * Why this exists.
 *
 * The voice-activity detector is an energy gate, and energy is a fact about the
 * room rather than about the sentence. It ends a segment after a fixed quiet
 * gap, so "what's the weather in — " *pause* " — London" is two segments, two
 * transcripts and, before this, two turns: the first one asking the model a
 * truncated question, the second arriving as a bare noun with no question left
 * to attach it to. People pause. They pause to think of the word, to look at
 * something, mid-list, before the important part. An assistant that treats the
 * first gap as the end of the thought is one you have to talk to carefully, and
 * having to talk carefully is the whole failure.
 *
 * So the segment is no longer the turn. Transcripts accumulate here, and the
 * turn fires only when the text looks finished AND the room has gone quiet.
 *
 * Crucially this costs nothing in the common case. A complete sentence with no
 * one speaking fires immediately — `holdFor` returns 0 — so the latency of an
 * ordinary question is exactly what it was. The waiting only happens when there
 * is a reason to wait.
 */

/**
 * Ending on one of these means the sentence is not over, whatever the silence
 * says. Function words only: they are closed-class, so the list is complete in
 * a way a content-word list could never be, and none of them is a plausible
 * last word of a real request.
 */
const CONTINUES =
  /\b(and|or|but|so|because|since|if|when|while|that|which|who|whose|to|of|in|on|at|by|for|with|from|about|into|onto|over|under|between|through|the|a|an|my|your|his|her|its|our|their|is|are|was|were|be|been|do|does|did|have|has|had|can|could|would|should|will|shall|might|must|like|than|then|as|very|really|just|some|any|all|both|either|neither)$/i

/** Trailing punctuation a transcriber emits mid-thought. */
const TRAILS = /[,;:–—-]$/


/**
 * A quiet gap this long with a finished-looking sentence ends the turn.
 *
 * Small on purpose: by the time a transcript reaches the assembler the detector
 * has already sat through SILENCE_MS of quiet and the transcriber has taken its
 * own few hundred milliseconds, so roughly a second of real silence has passed
 * already. All this window has to catch is someone drawing breath to add one
 * more clause. Making it generous here is what would make every ordinary
 * question feel slow.
 */
const SETTLE_MS = 250
/** ...and this long when the sentence is plainly unfinished. */
const CONTINUE_MS = 1600
/**
 * Nothing is held longer than this in total. A ceiling rather than a timer:
 * without it, someone who ends every clause on "and" could hold a turn open
 * for ever, and the assistant would look like it had stopped listening.
 */
const MAX_HOLD_MS = 6000

/**
 * How long to keep waiting, given what has been said so far.
 * 0 means "this is a complete thought, send it now".
 */
function holdFor(text: string): number {
  const words = text.trim().split(/\s+/).filter(Boolean)
  if (!words.length) return CONTINUE_MS
  // An explicit terminator is the speaker telling us they are done.
  if (/[.!?]$/.test(text)) return 0
  if (TRAILS.test(text.trim())) return CONTINUE_MS
  if (CONTINUES.test(words[words.length - 1])) return CONTINUE_MS
  // One or two words is usually the start of something, not the whole of it —
  // except for the short commands that genuinely are complete.
  if (words.length <= 2 && !OVERRIDE.test(text)) return CONTINUE_MS
  return SETTLE_MS
}

type Assembler = {
  /** Add a transcript. `active` is true if the user is audibly still going. */
  feed: (text: string, active: boolean) => void
  /** Send whatever is held right now, if anything. */
  flush: () => void
  /** Throw away whatever is held — used when he stands down. */
  cancel: () => void
  held: () => string
}

function makeAssembler(h: {
  emit: (text: string) => void
  partial: (text: string) => void
}): Assembler {
  let held = ''
  let timer: ReturnType<typeof setTimeout> | null = null
  let firstAt = 0

  const clear = () => {
    if (timer) clearTimeout(timer)
    timer = null
  }

  const fire = () => {
    clear()
    const text = held.trim()
    held = ''
    firstAt = 0
    if (text) h.emit(text)
  }

  return {
    feed(text, active) {
      if (!text.trim()) return
      held = `${held} ${text}`.replace(/\s+/g, ' ').trim()
      if (!firstAt) firstAt = Date.now()
      // The caption shows the whole thought as it assembles, not just the
      // fragment that happened to arrive last.
      h.partial(held)
      diag.holding = held
      clear()

      // Already talking again. Decide nothing now — the next transcript is
      // part of this same sentence and will bring more of it.
      if (active) {
        timer = setTimeout(fire, MAX_HOLD_MS)
        return
      }

      const wait = Math.min(
        holdFor(held),
        Math.max(0, MAX_HOLD_MS - (Date.now() - firstAt)),
      )
      diag.waitedMs = wait
      if (wait === 0) {
        fire()
        return
      }
      timer = setTimeout(fire, wait)
    },
    flush: fire,
    cancel() {
      clear()
      held = ''
      firstAt = 0
      diag.holding = ''
    },
    held: () => held,
  }
}

// ---------------------------------------------------------------------------
// Hearing himself
// ---------------------------------------------------------------------------

const norm = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9' ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()

/**
 * Short words that must always cut through, even when they collide with what
 * he happens to be saying. Suppressing "stop" because he just said "stop"
 * would be the single most infuriating failure this file could have.
 */
const OVERRIDE =
  /\b(stop|wait|cortana|kortana|cancel|enough|quiet|hold on|shut up|never ?mind|forget it|no)\b/i

/**
 * Words too common to be evidence of anything.
 *
 * This set is the difference between a usable filter and an infuriating one.
 * "What about the second one?" is a perfectly ordinary follow-up, and every
 * word in it is likely to appear somewhere in the answer it follows — so a
 * naive bag-of-words match suppresses the user's real question as an echo.
 * Only distinctive words count as proof he is hearing himself.
 */
const STOP = new Set(
  ('a an the and or but so of to in on at by for with from is are was were be ' +
    'it its this that these those i you he she we they me him her them my your ' +
    'our their what which who how why when where do does did can could would ' +
    'should will shall not no yes if then than as about into over under out up ' +
    'down one two three first second third now here there just very really got ' +
    'get have has had say said tell me okay ok well right').split(' '),
)

/**
 * Is this the microphone hearing the speakers?
 *
 * Compared as bags of words rather than by string distance: the recogniser
 * mangles its own playback badly enough that a substring match rarely holds,
 * but the *words* survive.
 */
function isEcho(heard: string, spoken: string): boolean {
  if (!spoken) return false
  if (OVERRIDE.test(heard)) return false

  const all = norm(heard).split(' ').filter(Boolean)
  if (!all.length) return true

  const mine = new Set(norm(spoken).split(' '))
  // "Eli" is spoken as "Ee-lye" (speakable.ts) but heard back as Eli, Ely or
  // Ellie; without these her own "Yes, Eli?" reads as an interruption.
  if (mine.has('lye')) for (const w of ['eli', 'ely', 'elie', 'ellie', 'e', 'lie']) mine.add(w)
  const content = all.filter((w) => !STOP.has(w))

  // Nothing distinctive was said at all, so there is no strong evidence either
  // way. Demand a total match before discarding it — the cost of dropping a
  // real question is much higher than the cost of one stray echo getting in.
  if (content.length < 2) {
    if (all.length < 2) return false
    return all.every((w) => mine.has(w))
  }

  let hits = 0
  for (const w of content) if (mine.has(w)) hits++
  return hits / content.length >= 0.6
}

// ---------------------------------------------------------------------------
// Diagnostics
// ---------------------------------------------------------------------------

/**
 * Live state of the voice loop, published on `window.__voice`.
 *
 * When someone says the wake word and nothing happens there are only a handful
 * of possible causes — the recogniser never started, it started and died, it is
 * running but hearing silence, or it is hearing you and transcribing the name
 * as something else. From outside the page those are indistinguishable, which
 * makes the failure impossible to report and impossible to fix. This tells them
 * apart in one glance.
 */
export const diag = {
  /** Speech-to-text: 'on-device' (Chrome, local), 'cloud' (Chrome, Google) or 'none'. */
  engine: 'none',
  /**
   * How the wake word is heard: 'porcupine', 'on-device', 'cloud',
   * 'push-to-talk', or 'pack-downloading' (push-to-talk until Chrome's speech
   * pack arrives, then 'on-device' by itself).
   */
  wake: 'push-to-talk',
  /** Chrome on-device language pack: available, downloadable, downloading, unavailable or unsupported. */
  onDevice: 'unknown',
  /** Whether the recogniser keeps listening while Jarvis is idle. */
  alwaysOn: false,
  /** Whether the microphone pipeline is live. */
  running: false,
  /** Speech segments captured since load. */
  sessions: 0,
  /** The most recent transcript, whatever the mode. */
  heard: '',
  heardAt: 0,
  /** Last failure — a transcription error, or a capture error. */
  lastError: '',
  /** Times the wake word matched. */
  wakes: 0,
  /** True when Eli turned the wake word off (W). */
  wakeOff: false,
  /** The last few wake candidates that were refused, newest first, for tuning. */
  rejected: [] as string[],
  /** Current mode, as the app last reported it. */
  mode: '',
  /** Why the last transcript was ignored — '' when it was accepted. */
  dropped: '',
  /** Transcripts accepted and passed to the app. */
  accepted: 0,
  /** Text assembled but not yet sent, because the thought looks unfinished. */
  holding: '',
  /** How long the assembler decided to wait before sending, in ms. */
  waitedMs: 0,
  /** Barge-ins suppressed because he had only just started the sentence. */
  selfGuarded: 0,
  /** Transcription failures (network, or the bridge speech proxy). */
  restarts: 0,
  /** Milliseconds the last transcription round-trip took. */
  idleMs: 0,
}

/** Record why a transcript went nowhere. Silence always has a reason; this is
 *  the difference between debugging it and speculating about it. */
function drop(why: string) {
  diag.dropped = why
}

function rejectWake(text: string, why: string) {
  diag.rejected = [`"${text.slice(-40)}": ${why}`, ...diag.rejected].slice(0, 6)
  drop(`wake refused: ${why}`)
}

diag.wakeOff = !wakeEnabled

if (typeof window !== 'undefined') {
  ;(window as unknown as Record<string, unknown>).__voice = diag
}

export type WakeOptions = {
  /** JARVIS_WAKE from the settings (Jarvis settings.txt or .env.local). */
  mode: 'auto' | 'on-device' | 'cloud' | 'off'
  /** PICOVOICE_ACCESS_KEY from the settings, if Eli has one. */
  porcupineKey: string | null
}

const LANG = 'en-US'

type RecognitionCtor = {
  new (): any
  available?: (o: { langs: string[]; processLocally: boolean }) => Promise<string>
  install?: (o: { langs: string[]; processLocally: boolean }) => Promise<boolean>
  availableOnDevice?: (lang: string) => Promise<string>
  installOnDevice?: (lang: string) => Promise<boolean>
}

function recognitionCtor(): RecognitionCtor | null {
  const w = window as any
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null
}

/**
 * Can Chrome transcribe on this Mac without sending audio to Google?
 *
 * Chrome's on-device recognition (processLocally) needs a one-time language
 * pack of about 60 MB. Two API shapes have shipped; both are tried. Returns
 * 'available', 'downloadable', 'downloading', 'unavailable' or 'unsupported'.
 */
/**
 * Only Google Chrome ships the on-device speech service. In a build without it
 * (Chromium, the headless shell used for screenshots) merely asking about it
 * makes the browser kill the tab for an unknown Mojo interface, so we ask
 * only when the brand says Google Chrome.
 */
function hasOnDeviceService(): boolean {
  const brands = (navigator as Navigator & { userAgentData?: { brands?: Array<{ brand: string }> } })
    .userAgentData?.brands
  return Boolean(brands?.some((b) => b.brand === 'Google Chrome'))
}

export async function onDeviceStatus(): Promise<string> {
  const Ctor = recognitionCtor()
  if (!Ctor) return 'unsupported'
  if (!hasOnDeviceService()) return 'unsupported'
  try {
    if (typeof Ctor.available === 'function') {
      return String(await Ctor.available({ langs: [LANG], processLocally: true }))
    }
    if (typeof Ctor.availableOnDevice === 'function') {
      return String(await Ctor.availableOnDevice(LANG))
    }
  } catch {
    return 'unavailable'
  }
  return 'unsupported'
}

/**
 * Start the language-pack download. Must be called from a click or key press.
 * Returns immediately; the pack arrives in the background.
 */
export function installOnDevice(): void {
  const Ctor = recognitionCtor()
  if (!hasOnDeviceService()) return
  try {
    if (typeof Ctor?.install === 'function') void Ctor.install({ langs: [LANG], processLocally: true }).catch(() => {})
    else if (typeof Ctor?.installOnDevice === 'function') void Ctor.installOnDevice(LANG).catch(() => {})
  } catch {
    /* not supported */
  }
}

/**
 * Start listening.
 *
 * Wake word, in order of preference:
 *   1. Porcupine, if PICOVOICE_ACCESS_KEY is set: "Jarvis" is detected in
 *      WebAssembly on this Mac, offline.
 *   2. Chrome's on-device recogniser, if its language pack is installed: it
 *      listens continuously for "Jarvis", and nothing leaves the Mac.
 *   3. Otherwise push-to-talk: Space, or click the reactor. The recogniser
 *      only runs during a conversation, so room audio is never streamed while
 *      Jarvis is idle. JARVIS_WAKE=cloud opts into Chrome's cloud recogniser
 *      listening all the time instead (audio goes to Google).
 * During a conversation the same recogniser transcribes commands and hears
 * barge-in ("stop", "Jarvis", or two words over his voice).
 */
export async function startVoice(h: VoiceHandlers, wake: WakeOptions): Promise<Voice> {
  try {
    await getMic()
  } catch (err) {
    diag.lastError = 'mic'
    h.onError(
      err instanceof DOMException && err.name === 'NotAllowedError'
        ? 'Microphone access denied. Allow it in Chrome, then reload.'
        : 'No microphone available.',
    )
    return { stop: () => {}, live: () => false }
  }

  const status = await onDeviceStatus()
  diag.onDevice = status
  const local = status === 'available' && wake.mode !== 'cloud'
  diag.engine = local ? 'on-device' : recognitionCtor() ? 'cloud' : 'none'

  let porcupine: Porcupine | null = null
  if (wake.porcupineKey && wake.mode !== 'off') {
    porcupine = await startPorcupine(wake.porcupineKey, () => {
      if (h.mode() !== 'wake' || !wakeEnabled) return
      diag.wakes++
      diag.accepted++
      h.onWake('')
    }).catch((err) => {
      console.warn('[jarvis] Porcupine unavailable:', err)
      diag.lastError = `porcupine: ${String((err as Error)?.message ?? err).slice(0, 80)}`
      return null
    })
  }

  // Listen all the time only where it costs no privacy (on-device), or where
  // Eli explicitly opted into the cloud recogniser.
  const alwaysOn = !porcupine && wake.mode !== 'off' && (local || wake.mode === 'cloud')
  diag.alwaysOn = alwaysOn
  // First run: the speech pack is still downloading (installOnDevice started it
  // on the power-on click). Push-to-talk for now; switch to the wake word as
  // soon as the pack arrives, without a reload.
  const pending =
    !porcupine && !alwaysOn && (wake.mode === 'auto' || wake.mode === 'on-device') &&
    (status === 'downloadable' || status === 'downloading')
  diag.wake = porcupine ? 'porcupine' : alwaysOn ? (local ? 'on-device' : 'cloud') : pending ? 'pack-downloading' : 'push-to-talk'

  let browser = startBrowserVoice(h, { alwaysOn, local })
  let stopped = false
  let packWatch: ReturnType<typeof setInterval> | null = null
  if (pending) {
    const giveUpAt = Date.now() + PACK_WAIT_MS
    let checking = false
    packWatch = setInterval(async () => {
      if (stopped || checking) return
      if (Date.now() > giveUpAt) {
        if (packWatch) clearInterval(packWatch)
        diag.wake = 'push-to-talk'
        h.onWakeChange?.(diag.wake)
        return
      }
      checking = true
      try {
        const now = await onDeviceStatus()
        diag.onDevice = now
        // Swap only while idle, so a conversation in progress is not cut.
        if (now !== 'available' || stopped || h.mode() !== 'wake') return
        if (packWatch) clearInterval(packWatch)
        browser.stop()
        browser = startBrowserVoice(h, { alwaysOn: true, local: true })
        diag.engine = 'on-device'
        diag.alwaysOn = true
        diag.wake = 'on-device'
        h.onWakeChange?.(diag.wake)
      } finally {
        checking = false
      }
    }, PACK_POLL_MS)
  }
  return {
    stop: () => {
      stopped = true
      if (packWatch) clearInterval(packWatch)
      porcupine?.stop()
      browser.stop()
    },
    live: () => browser.live() || Boolean(porcupine),
    kick: () => browser.kick(),
  }
}

/** How often to look for the speech pack while it downloads, and for how long. */
const PACK_POLL_MS = 4000
const PACK_WAIT_MS = 30 * 60_000

/** True when saying "Jarvis" works right now (as opposed to Space / click). */
export const wakeWordLive = () => diag.wake !== 'push-to-talk' && diag.wake !== 'pack-downloading'

/* -------------------------------------------------------------------------- */
/* Browser fallback: SpeechRecognition                                        */
/* -------------------------------------------------------------------------- */

/**
 * Chrome's SpeechRecognition, for the wake word (when always on) and for
 * transcribing commands. On-device when the language pack is installed.
 *
 * It is the flakier engine — Chrome throttles it and it can go silent with no
 * event to catch — so a heartbeat watches it and forces a fresh session
 * whenever it stops showing signs of life. That single guard is the difference
 * between "the wake word stopped working halfway through the lesson" and an
 * assistant that keeps listening.
 */
function startBrowserVoice(
  h: VoiceHandlers,
  opts: { alwaysOn: boolean; local: boolean },
): Voice & { kick: () => void } {
  const Ctor = recognitionCtor()
  if (!Ctor) {
    h.onError('This browser has no speech recognition. Open Cortana in Google Chrome.')
    return { stop: () => {}, live: () => false, kick: () => {} }
  }

  /** Should the recogniser be running in this mode? */
  const wanted = () => {
    const m = h.mode()
    if (m === 'deaf') return false
    if (m === 'wake') return opts.alwaysOn && wakeEnabled
    return true
  }

  let stopped = false
  let running = false
  let rec: any = null
  let settled = ''
  let interim = ''
  let started = false
  let barged = false
  let lastWake = 0
  let lastAlive = Date.now()
  let silenceTimer: ReturnType<typeof setTimeout> | null = null

  /** Same assembly rules as the premium path — a pause is not a full stop. */
  const assemble = makeAssembler({
    emit: (text) => {
      diag.dropped = ''
      diag.accepted++
      diag.holding = ''
      h.onUtterance(text)
    },
    partial: (text) => h.onPartial(text),
  })

  const touch = () => {
    lastAlive = Date.now()
  }

  const clearSilence = () => {
    if (silenceTimer) clearTimeout(silenceTimer)
    silenceTimer = null
  }

  const reset = () => {
    clearSilence()
    settled = ''
    interim = ''
    started = false
    barged = false
  }

  const emit = () => {
    const text = `${settled} ${interim}`.replace(/\s+/g, ' ').trim()
    const mode = h.mode()
    reset()
    if (!text || mode === 'deaf') return
    if (isEcho(text, speakingNow())) {
      drop('echo of his own voice')
      return
    }
    diag.heard = text
    diag.heardAt = Date.now()
    if (mode === 'wake') {
      // Waking happens in onResult, on final results only. What reaches here
      // never became final, and a half-heard guess is how noise became her name.
      assemble.cancel()
      if (WAKE.test(text)) rejectWake(text, 'never confirmed as a final result')
      else drop(`heard "${text.slice(-40)}" — not her name`)
      return
    }
    // The recogniser has already endpointed on its own 900ms gap; the assembler
    // decides whether that gap actually ended the thought. `false` because a
    // result only reaches here once the recogniser has gone quiet.
    assemble.feed(text, false)
  }

  const bumpSilence = () => {
    clearSilence()
    // Endpoint on a short quiet gap; upstream tuned this more
    // finely, but a fixed window is plenty for the fallback.
    silenceTimer = setTimeout(emit, 900)
  }

  const onResult = (e: any) => {
    touch()
    const mode = h.mode()
    diag.mode = mode
    if (mode === 'deaf') {
      interim = ''
      return
    }
    let fresh = ''
    let conf = 0
    interim = ''
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const chunk = e.results[i][0].transcript as string
      if (e.results[i].isFinal) {
        fresh += chunk
        conf = Math.max(conf, Number(e.results[i][0].confidence) || 0)
      } else interim += chunk
    }
    const heard = `${settled}${fresh} ${interim}`.replace(/\s+/g, ' ').trim()
    if (!heard) return
    if (isEcho(`${fresh} ${interim}`, speakingNow())) {
      interim = ''
      return
    }

    if (mode === 'wake') {
      settled += fresh
      // Final results only, confident ones, and not while she is talking.
      if (fresh && WAKE.test(settled)) {
        const why = wakeVerdict(settled, conf, { enabled: wakeEnabled, speaking: Boolean(speakingNow()) })
        if (why) {
          rejectWake(settled, why)
          settled = ''
        } else if (Date.now() - lastWake <= WAKE_DEBOUNCE) {
          rejectWake(settled, 'too soon after the last wake')
          settled = ''
        } else {
          lastWake = Date.now()
          diag.wakes++
          diag.accepted++
          diag.dropped = ''
          const trailing = afterWake(settled)
          reset()
          h.onWake(trailing)
        }
      } else if (settled.length > 400) {
        settled = ''
      }
      return
    }

    settled += fresh
    const full = `${settled} ${interim}`.replace(/\s+/g, ' ').trim()
    if (!started || (mode === 'guard' && !barged)) {
      const words = full.split(/\s+/).filter(Boolean).length
      if (mode === 'guard') {
        // While she is thinking or talking, only her name cuts in ("Cortana",
        // "Cortana, stop"). Through laptop speakers anything else was too
        // often her own voice coming back, and she kept cutting herself off.
        // What she hears in the meantime is dropped, so it never lands in
        // the next question either.
        if (!WAKE.test(full)) {
          diag.selfGuarded++
          settled = ''
          interim = ''
          return
        }
      } else if (words < 1) {
        return
      }
      started = true
      if (mode === 'guard') barged = true
      h.onSpeechStart()
    }
    diag.dropped = ''
    // Show the whole thought, not just the fragment being spoken now — there
    // may be an earlier half of it held by the assembler.
    const carried = assemble.held()
    h.onPartial(carried ? `${carried} ${full}` : full)
    bumpSilence()
  }

  // Chrome refuses the whole session with "phrases-not-supported" when the
  // on-device recogniser cannot bias; then every restart failed the same way
  // and nothing was ever heard. Drop the phrases after the first refusal.
  let usePhrases = true

  const spin = () => {
    if (stopped || running || rec) return
    if (!wanted()) return
    rec = new Ctor()
    rec.continuous = true
    rec.interimResults = true
    rec.lang = LANG
    if (opts.local) {
      // Both spellings have shipped in Chrome; setting the wrong one is a no-op.
      try {
        rec.processLocally = true
      } catch {
        /* older build */
      }
      try {
        if ('mode' in rec) rec.mode = 'ondevice-only'
      } catch {
        /* newer build */
      }
    }
    // Bias recognition toward the names that matter here.
    try {
      const Phrase = (window as any).SpeechRecognitionPhrase
      // Not her name: boosting "Cortana" made Chrome hear it in every small noise.
      if (Phrase && usePhrases) rec.phrases = [new Phrase('Donevia', 2), new Phrase('credit union', 2)]
    } catch {
      /* contextual biasing not supported */
    }
    rec.onstart = () => {
      running = true
      diag.running = true
      diag.sessions++
      touch()
    }
    rec.onresult = onResult
    rec.onerror = (ev: any) => {
      diag.lastError = String(ev.error ?? '')
      console.warn('[jarvis] speech recognition error:', ev.error, ev.message ?? '')
      if (ev.error === 'phrases-not-supported') usePhrases = false
      if (ev.error === 'not-allowed' || ev.error === 'service-not-allowed') {
        stopped = true
        diag.running = false
        h.onError('Microphone access was refused. Allow it in Chrome, then reload.')
      }
    }
    rec.onend = () => {
      running = false
      diag.running = false
      touch()
      rec = null
      if (!stopped && wanted()) setTimeout(spin, 80)
    }
    try {
      rec.start()
    } catch {
      running = false
      rec = null
      setTimeout(spin, 250)
    }
  }

  /** Stop listening (push-to-talk while idle): nothing is captured or sent. */
  const halt = () => {
    if (!rec) return
    const r = rec
    rec = null
    running = false
    diag.running = false
    reset()
    try {
      r.abort()
    } catch {
      /* already gone */
    }
  }

  spin()

  // Follow the app's mode: run during a conversation, and while idle only if
  // always-on. Polled because nothing in the app pushes phase changes here.
  const follow = setInterval(() => {
    if (stopped) return
    if (wanted()) {
      if (!rec) spin()
    } else if (rec) {
      halt()
      assemble.cancel()
    }
  }, 200)

  // The heartbeat. If nothing has been heard from the engine for a while it has
  // gone quiet on us — tear it down and build a fresh one.
  const health = setInterval(() => {
    if (stopped || !wanted()) return
    const idle = Date.now() - lastAlive
    diag.idleMs = idle
    if (idle < 15000) return
    diag.restarts++
    try {
      rec?.abort()
    } catch {
      /* already gone */
    }
    rec = null
    running = false
    diag.running = false
    touch()
    spin()
  }, 5000)

  return {
    kick: () => {
      touch()
      spin()
    },
    stop: () => {
      stopped = true
      clearInterval(health)
      clearInterval(follow)
      clearSilence()
      assemble.cancel()
      diag.running = false
      try {
        rec?.abort()
      } catch {
        /* noop */
      }
    },
    live: () => running,
  }
}
