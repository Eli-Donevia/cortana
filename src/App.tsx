import { useEffect, useRef } from 'react'
import { Scene } from './scene/Scene'
import { Hud } from './ui/Hud'
import { Boot } from './ui/Boot'
import { Ignition } from './ui/Ignition'
import { Diagnostics } from './ui/Diagnostics'
import { useStore } from './store'
import { startVoice, installOnDevice, diag as voiceDiag, type Voice, type VoiceMode } from './lib/voice'
import { createSpeaker, cycleVoice, currentVoiceName, cycleKokoroVoice, kokoroSpeaking } from './lib/tts'
import * as sfx from './lib/sfx'
import * as kokoro from './lib/kokoro'
import { loadRuntime, runtime } from './lib/runtime'
import { forTool, attention } from './lib/fillers'
import {
  ask,
  warm,
  interrupt,
  watchServers,
  watchBlades,
  watchDataPath,
  watchUi,
  watchConnection,
  connectedLabels,
} from './lib/brain'
import { startAnalyser, micLevel } from './lib/audio'
import { setWakeWord, shownWake, toggleWakeWord, wakeCommand } from './lib/wakeSwitch'
import { watchAgentEvents } from './lib/bridge'

/**
 * The conversation.
 *
 * This used to be a sequential loop — greet, await a capture, await an answer,
 * repeat — with the microphone opened and closed around each step. That shape
 * cannot be interrupted: while it is awaiting the answer, nothing is listening,
 * so there is no way for the user to get a word in.
 *
 * It is an event machine now. The voice loop runs continuously and pushes
 * events at us; every one of them is legal in every phase. Saying anything at
 * all stops him talking, and whatever you say next becomes the new turn.
 *
 * Donevia fork: camera, hand gestures, clap-to-start and music are gone; a
 * turn starts from the wake word (when it can be heard privately), Space, or
 * a click on the reactor.
 */

/** How long to wait for someone to start speaking after he wakes. Generous:
 *  people say his name and *then* think about what they wanted. */
const AWAIT_SPEECH_MS = 14000

/** After an answer, how long the mic stays open for a follow-up before he
 *  drops back to standby. Long enough that you don't have to say the name
 *  again to continue a thought. */
const FOLLOW_UP_MS = 11000

/** crypto.randomUUID needs a secure context, which a LAN address over plain
 *  http is not. Not worth failing a whole turn over an id. */
const newId = () =>
  globalThis.crypto?.randomUUID?.() ??
  `id${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`

/** The same mishearings voice.ts accepts for the wake word, so "travis" is
 *  never sent on to the model as a question. */
const NAME = '(?:cortana|kortana)'
/** A bare vocative — "Jarvis", "hey jarvis" — with nothing asked. */
const BARE_NAME = new RegExp(`^(?:hey|hi|ok|okay|yo)?\\s*${NAME}[\\s,.!?]*$`, 'i')
/** A leading vocative on a real command: "Jarvis, what's the weather". */
const LEADING_NAME = new RegExp(`^(?:hey|hi|ok|okay|yo)?\\s*${NAME}\\b[\\s,.:!?-]*`, 'i')

export default function App() {
  const store = useStore
  const speaker = useRef<ReturnType<typeof createSpeaker> | null>(null)
  const voice = useRef<Voice | null>(null)

  /**
   * Monotonic turn counter. Every await in a turn checks it on the way out:
   * if it has moved, that turn was superseded by a barge-in and must not touch
   * the phase, the speaker, or the busy state on its way to the floor.
   */
  const turn = useRef(0)
  const booting = useRef(false)
  const idleTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const voicePoll = useRef<ReturnType<typeof setInterval> | null>(null)

  // -- helpers --------------------------------------------------------------

  const clearIdle = () => {
    if (idleTimer.current) clearTimeout(idleTimer.current)
    idleTimer.current = null
  }

  const silence = () => {
    speaker.current?.cancel()
    speaker.current = null
  }

  /** Agent heads-ups ("your agent is done…"), spoken only while she is idle, never over Eli. */
  const headsUp = useRef<string[]>([])
  const sayHeadsUp = () => {
    if (store.getState().phase !== 'dormant' || !headsUp.current.length) return
    const t = createSpeaker()
    speaker.current = t
    t.say(headsUp.current.shift()!)
    void t.end().then(() => {
      if (headsUp.current.length) setTimeout(sayHeadsUp, 400)
    })
  }

  const goDormant = () => {
    clearIdle()
    silence()
    turn.current++
    const s = store.getState()
    s.setCaption('')
    s.setActiveTool(null)
    sfx.duck(false)
    s.setPhase('dormant')
    setTimeout(sayHeadsUp, 700)
  }

  /** Open the mic and wait. `window` is how long before he gives up. */
  const listen = (window: number) => {
    clearIdle()
    const s = store.getState()
    s.setCaption('')
    s.setPhase('listening')
    sfx.play('listen')
    idleTimer.current = setTimeout(goDormant, window)
  }

  // -- one turn -------------------------------------------------------------

  const respond = async (said: string): Promise<void> => {
    // "Stop listening for your name" is handled here, never sent to the model.
    const wakeCmd = wakeCommand(said)
    if (wakeCmd !== null) {
      setWakeWord(wakeCmd)
      const line = wakeCmd ? "Okay, I'm listening for my name again." : "Okay. I'll wait for Space, or press W to turn my name back on."
      const t = createSpeaker()
      speaker.current = t
      t.say(line)
      void t.end().then(() => goDormant())
      return
    }
    const mine = ++turn.current
    const stale = () => mine !== turn.current

    clearIdle()
    const s = store.getState()
    // Last turn's cards go now, before the new answer starts putting its own
    // up. Anything the model marked sticky survives.
    s.clearBlades()
    s.setCaption('')
    s.pushTurn({ id: newId(), role: 'user', text: said })
    s.setPhase('thinking')

    const spk = createSpeaker()
    speaker.current = spk
    sfx.duck(true)

    const turnId = newId()
    let started = false
    let filled = false

    try {
      await ask(said, {
        onText: (delta) => {
          if (stale()) return
          if (!started) {
            started = true
            store.getState().setPhase('speaking')
            // The answer arriving is what ends the tool phase — a timer would
            // clear the readout while a slow tool was still running.
            store.getState().setActiveTool(null)
            store.getState().pushTurn({ id: turnId, role: 'jarvis', text: '' })
          }
          store.getState().appendToLastTurn(delta)
          spk.push(delta)
        },
        onTool: (label, raw) => {
          if (stale()) return
          // Only claim the tooling phase while he has nothing to say yet.
          // Setting it unconditionally pinned the machine in 'tooling' for the
          // rest of any answer that called a tool after it started talking,
          // which also broke the reactor's lip-sync for the remainder.
          if (!started) store.getState().setPhase('tooling')
          store.getState().setActiveTool(label)
          sfx.play('tool')
          // Say something the moment work starts — a tool can take ten seconds
          // and silence that long reads as a crash. Once per turn only.
          if (!filled && !started) {
            filled = true
            spk.say(forTool(label, raw))
          }
        },
      })

      if (stale()) return

      await spk.end()
      if (stale()) return
      sfx.play('done')
    } catch (err) {
      if (stale()) return
      console.error(err)
      sfx.play('error')
      store
        .getState()
        .setError(err instanceof Error ? err.message : 'Something went wrong.')
    } finally {
      if (!stale()) {
        speaker.current = null
        sfx.duck(false)
        store.getState().setActiveTool(null)
        // Stay open. Having to say his name again to add one more sentence is
        // the difference between a conversation and a vending machine.
        listen(FOLLOW_UP_MS)
      }
    }
  }

  // -- voice events ---------------------------------------------------------

  /** What the voice loop should do with what it hears, derived from phase. */
  const mode = (): VoiceMode => {
    switch (store.getState().phase) {
      case 'offline':
      case 'boot':
        return 'deaf'
      case 'dormant':
        return 'wake'
      case 'waking':
      case 'listening':
        return 'command'
      default:
        return 'guard' // thinking, tooling, speaking
    }
  }

  const onWake = (trailing: string) => {
    const phase = store.getState().phase
    if (phase === 'offline' || phase === 'boot') return

    store.getState().setError(null)
    sfx.play('wake')

    // "Jarvis, what's next" in one breath. Waiting for a greeting he didn't
    // need is the most common way an assistant wastes time.
    if (trailing) {
      void respond(trailing)
      return
    }

    store.getState().setPhase('waking')
    // Push-to-talk: start the recogniser now rather than on the next poll.
    voice.current?.kick?.()

    // Answer to his name. Deliberately NOT awaited any more: the microphone is
    // already open and the echo filter knows his voice, so the user can talk
    // straight over the greeting instead of waiting it out.
    const greeting = createSpeaker()
    speaker.current = greeting
    greeting.say(attention())
    void greeting.end()

    listen(AWAIT_SPEECH_MS)
  }

  /**
   * Someone started talking. This is the whole point of the rewrite: he stops,
   * immediately, whatever he was doing.
   */
  const onSpeechStart = () => {
    clearIdle()
    const phase = store.getState().phase
    if (phase === 'offline' || phase === 'boot' || phase === 'dormant') return

    const wasBusy =
      phase === 'thinking' || phase === 'tooling' || phase === 'speaking'

    silence()
    if (wasBusy) {
      // Abandon the answer in flight. The turn counter moves in respond()'s
      // replacement; bumping it here covers the case where nothing replaces it.
      turn.current++
      interrupt()
      store.getState().setActiveTool(null)
      sfx.duck(false)
    }
    store.getState().setPhase('listening')
  }

  const onUtterance = (text: string) => {
    const phase = store.getState().phase
    if (phase === 'offline' || phase === 'boot' || phase === 'dormant') return

    // People keep using his name as a vocative once they're already talking to
    // him. Strip it rather than sending "jarvis" to the model as a question.
    if (BARE_NAME.test(text)) {
      listen(AWAIT_SPEECH_MS)
      return
    }
    const said = text.replace(LEADING_NAME, '').trim()
    if (!said) {
      listen(AWAIT_SPEECH_MS)
      return
    }

    void respond(said)
  }

  const onPartial = (text: string) => {
    store.getState().setCaption(text)
  }

  const onVoiceError = (message: string) => {
    store.getState().setError(message)
  }

  // -- power on -------------------------------------------------------------

  const powerOn = async () => {
    // The ignition button and the space bar can both land here, and the phase
    // only moves after the first await — so without this a double press boots
    // twice, arming two voice loops and two download polls.
    if (booting.current) return
    booting.current = true

    try {
      await ignite()
    } catch (err) {
      // The guard must not outlive a failed boot. Audio unlock can be refused,
      // the microphone prompt dismissed, the bridge unreachable at the wrong
      // moment — and with the flag still latched the ignition button was dead
      // for the rest of the page, recoverable only by reloading. Reset it and
      // put the button back so the user can simply press it again.
      booting.current = false
      console.error('[jarvis] power-up failed:', err)
      store.getState().setPhase('offline')
      store
        .getState()
        .setError(
          err instanceof Error
            ? `Power-up failed: ${err.message}`
            : 'Power-up failed. Click to try again.',
        )
    }
  }

  const ignite = async () => {
    const s = store.getState()

    // Inside the click: browsers only start audio from a user gesture.
    await sfx.unlockAudio()
    sfx.play('boot')
    s.setPhase('boot')

    // Settings from the settings file, via the bridge. Fast, and never throws.
    const rt = await loadRuntime()

    // Chrome's on-device speech pack (about 60 MB, once) is what lets Jarvis
    // listen for his name without sending audio anywhere. The download needs
    // the click we are still inside; it is a no-op once installed.
    if (rt.wake.mode === 'auto' || rt.wake.mode === 'on-device') installOnDevice()

    watchServers((servers) => store.getState().setConnected(servers))
    watchDataPath((p) => store.getState().setDataPath(p))
    watchBlades((blade) => store.getState().pushBlade(blade))
    watchAgentEvents((e) => {
      store.getState().fireEffect('pulse')
      headsUp.current.push(e.line)
      sayHeadsUp()
    })
    watchUi((op, args) => {
      const s = store.getState()
      const a = (args ?? {}) as Record<string, never>
      switch (op) {
        case 'patch':
          s.applyUi(args)
          break
        case 'effect':
          s.fireEffect(a.kind)
          break
        case 'reset':
          s.resetUi()
          break
        case 'screen':
          s.clearScreen(a.what ?? 'all')
          break
        default:
          console.warn('[jarvis] unknown ui op:', op, args)
      }
    })
    // The conversation lives in the bridge session, which is tied to the
    // socket — so a drop wipes his memory while the transcript still shows it.
    watchConnection((state) => {
      if (state === 'lost') {
        store.getState().setError('Bridge connection lost. Reconnecting.')
      } else if (state === 'reconnected') {
        store.getState().setError('Reconnected. The previous conversation was not kept.')
      } else if (state === 'replaced') {
        store.getState().setError('Cortana is open in another window. Ask here to take it back.')
      }
    })
    const warming = warm().catch((err: Error) => s.setError(err.message))

    // Long enough for Boot.tsx's three beats; a founder's tool, not a trailer.
    await new Promise((r) => setTimeout(r, 4600))
    await warming
    store.getState().setConnected(connectedLabels())
    store.getState().setVoice(currentVoiceName())

    // The analyser makes the reactor pulse with your voice. A failure costs the
    // animation and nothing else.
    try {
      await startAnalyser()
    } catch {
      console.warn('[jarvis] no microphone stream; the reactor will not pulse with your voice.')
    }

    voice.current = await startVoice(
      {
        mode,
        onWake,
        onSpeechStart,
        onPartial,
        onUtterance,
        onError: onVoiceError,
        onWakeChange: (w) => store.getState().setWake(shownWake(w)),
      },
      runtime().wake,
    )
    store.getState().setWake(shownWake(voiceDiag.wake))

    store.getState().setPhase('dormant')

    // Kokoro started loading when the page opened (see the effect below); this
    // only covers a settings file that the first /config read missed.
    if (rt.tts.engine === 'kokoro') void kokoro.load()
  }

  /** A click on the reactor or the talk button: the same as Space. */
  const talk = () => {
    const phase = store.getState().phase
    if (phase === 'offline') return void powerOn()
    if (phase === 'boot') return
    if (phase === 'thinking' || phase === 'tooling' || phase === 'speaking') {
      onSpeechStart()
      listen(AWAIT_SPEECH_MS)
      voice.current?.kick?.()
      return
    }
    onWake('')
  }

  // -- level pump + keys ----------------------------------------------------

  useEffect(() => {
    let raf = 0

    const pump = () => {
      const st = store.getState()
      // While speaking, follow JARVIS's own output rather than the mic, so the
      // orb lip-syncs instead of reacting to room noise.
      const lvl =
        st.phase === 'speaking' && speaker.current
          ? speaker.current.level()
          : micLevel()
      st.setLevel(lvl)
      raf = requestAnimationFrame(pump)
    }
    pump()

    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA') return

      // V auditions the next voice: Kokoro's when Kokoro is speaking (live,
      // remembered in this browser), otherwise the next British voice
      // installed on this Mac. Shift+V always steps the Mac voice, which is
      // the one used while Kokoro loads. Bare V only: Cmd+V and Ctrl+V are
      // paste, and swallowing those was rude.
      if (
        (e.key === 'v' || e.key === 'V') &&
        !e.repeat &&
        !e.metaKey &&
        !e.ctrlKey &&
        !e.altKey
      ) {
        e.preventDefault()
        let name: string
        let sample: string
        const kokoroVoice = !e.shiftKey && kokoroSpeaking()
        if (kokoroVoice) {
          ;({ name, sample } = cycleKokoroVoice())
        } else {
          const sys = cycleVoice()
          name = sys
          sample = `System voice set to ${sys.replace(/\(.*?\)/g, '').trim()}. Good evening, Eli.`
          // Shift+V while Kokoro is speaking changes the stand-in voice, which
          // is not the one you would hear; show what is actually speaking.
          if (kokoroSpeaking()) name = currentVoiceName()
        }
        store.getState().setVoice(name)
        silence()
        // The sample is always in the voice just chosen, Mac or Kokoro.
        const demo = createSpeaker({ system: !kokoroVoice })
        speaker.current = demo
        demo.say(sample)
        void demo.end()
        return
      }

      // T speaks a fixed line, bypassing the wake word, the recogniser and the
      // model entirely. When "I can't hear him" is the report, this is the one
      // keypress that separates a broken voice engine from a broken voice loop
      // — and it prints the verdict rather than making you infer it.
      if (e.key === 't' && !e.repeat && !e.metaKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault()
        silence()
        const t = createSpeaker()
        speaker.current = t
        t.say('Audio test. If you can hear this, speech is working, Eli.')
        void t.end().then(() => {
          const d = (window as unknown as Record<string, Record<string, unknown>>).__tts
          console.info('[jarvis] audio test →', d)
          if (d && d.started === 0 && d.rescued === 0) {
            store.getState().setError(
              `No sound produced. engine=${d.engine} voice=${d.voice} error=${d.lastError || 'none'}`,
            )
          }
        })
        return
      }

      // W turns the wake word off (push-to-talk only) and back on. Remembered.
      if ((e.key === 'w' || e.key === 'W') && !e.repeat && !e.metaKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault()
        toggleWakeWord()
        return
      }

      // Escape stands the whole thing down — the one thing the old build had
      // no key for at all.
      if (e.key === 'Escape') {
        e.preventDefault()
        if (store.getState().phase !== 'offline') goDormant()
        return
      }

      // Space talks: starts a turn without the wake word, or cuts him off.
      if (e.code !== 'Space' || e.repeat) return
      e.preventDefault()
      talk()
    }
    window.addEventListener('keydown', onKey)

    // Start the Kokoro download as soon as the page opens, not after the
    // ignition click and boot sequence: those are the seconds it needs most.
    void loadRuntime().then((rt) => {
      if (rt.tts.engine === 'kokoro') void kokoro.load()
    })

    // Keep the HUD honest about which voice is speaking, and say why when it
    // is the Mac voice standing in for Kokoro (loading, too slow, failed).
    voicePoll.current = setInterval(() => {
      const st = store.getState()
      if (st.phase === 'offline') return
      const name = currentVoiceName()
      if (st.voice !== name) st.setVoice(name)
      const note = kokoro.fallback()
      if (st.voiceNote !== note) st.setVoiceNote(note)
    }, 500)

    return () => {
      cancelAnimationFrame(raf)
      window.removeEventListener('keydown', onKey)
      clearIdle()
      if (voicePoll.current) clearInterval(voicePoll.current)
      voice.current?.stop()
      speaker.current?.cancel()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <>
      <Scene />
      <Hud onTalk={talk} />
      <Boot />
      <Diagnostics />
      <Ignition onStart={() => void powerOn()} />
    </>
  )
}
