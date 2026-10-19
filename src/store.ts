import { create } from 'zustand'

export type Phase =
  | 'offline'   // waiting for the click that unlocks audio
  | 'boot'      // startup sequence
  | 'dormant'   // powered down, waiting for the wake word
  | 'waking'    // wake word hit, spin-up animation
  | 'listening' // capturing speech
  | 'thinking'  // model is generating
  | 'tooling'   // an MCP tool is running
  | 'speaking'  // reading the answer back

/**
 * A card on the display, composed by Jarvis with the `display` tool.
 *
 * Upstream also opened articles, images, video and a camera here; Donevia
 * Jarvis shows composed text only, so a card can never fetch anything remote.
 * The `html` is sanitised before it reaches the DOM.
 */
export type Blade = {
  id: string
  title: string
  kind: 'markup'
  html?: string
  accent?: 'default' | 'violet' | 'amber' | 'red' | 'mint'
  size: 'compact' | 'tall' | 'wide' | 'full'
  hold: 'turn' | 'sticky'
}

/** Which data source the bridge is using (bridge/datapath.mjs). */
export type DataPath = {
  active: 'hq-db' | 'connectors' | 'local-mcp' | 'none'
  hqDb: 'confirmed' | 'expected' | 'unavailable'
  hqTool: string | null
  connectors: string[]
  localMcp: string[]
  account: { email: string | null; subscription: string | null; apiKeySource: string | null } | null
  notes: string[]
  summary: string
}

export type Turn = {
  id: string
  role: 'user' | 'jarvis'
  text: string
  /** Tool names invoked while producing this turn, for the HUD readout. */
  tools?: string[]
}

/**
 * A one-shot flourish across the whole interface.
 *
 * The timestamp is the entire point. An effect is an event, not a state, but
 * it has to travel through a state store to reach the components that play it
 * — so asking for a glitch twice in a row must produce two glitches, and it
 * only does if something in the record actually changes between them.
 */
export type UiEffect = {
  kind: 'pulse' | 'scan'
  /** Timestamp; a NEW value re-triggers the effect even if kind is unchanged. */
  at: number
}

/**
 * Everything JARVIS can change about his own appearance.
 *
 * All of it is an override layer: at UI_DEFAULTS every field means "carry on as
 * before", so the interface is exactly the one that existed before any of this
 * was here. Nothing in here is allowed to become load-bearing for the ordinary
 * look of the page — a demo where the reactor only appears because a command
 * turned it on is a demo that breaks on reload.
 */
export type UiState = {
  /** Overrides the phase colour everywhere when set. null = follow the phase. */
  accent: string | null
  /** Page background colour. null = the stock near-black. */
  background: string | null
  /** Per-phase colour overrides, merged over the built-in phaseColor map. */
  palette: Partial<Record<Phase, string>>
  reactor: {
    /** null = follow accent/phase. */
    color: string | null
    /** Size multiplier. 0.2 .. 3, default 1. */
    scale: number
    /** Glow/brightness multiplier. 0 .. 3, default 1. */
    intensity: number
    /** Rotation-rate multiplier. 0 .. 5, default 1. */
    spin: number
    style: 'orb' | 'ring' | 'sphere' | 'wire'
    visible: boolean
  }
  chrome: {
    systems: boolean      // the left SYSTEMS rail
    transcript: boolean   // the conversation log
    toolBadge: boolean    // the active-tool readout under the reactor
    suggestions: boolean  // the "try saying…" hint
    brand: boolean        // the Cortana name in the header
  }
  effect: UiEffect | null
}

export const UI_DEFAULTS: UiState = {
  accent: null, background: null, palette: {},
  reactor: { color: null, scale: 1, intensity: 1, spin: 1, style: 'orb', visible: true },
  chrome: { systems: true, transcript: true, toolBadge: true, suggestions: true, brand: true },
  effect: null,
}

/**
 * A deep-partial of UiState, minus the effect, which is fired rather than set.
 */
export type UiPatch = {
  accent?: string | null
  background?: string | null
  palette?: Partial<Record<Phase, string>>
  reactor?: Partial<UiState['reactor']>
  chrome?: Partial<UiState['chrome']>
}

/**
 * A fresh copy of the defaults, never the exported object itself.
 *
 * UI_DEFAULTS is exported so components can compare against "untouched", and
 * handing the live store that same object would mean one careless in-place
 * write rewrote the baseline for the rest of the page's life.
 */
function defaultUi(): UiState {
  return {
    ...UI_DEFAULTS,
    palette: { ...UI_DEFAULTS.palette },
    reactor: { ...UI_DEFAULTS.reactor },
    chrome: { ...UI_DEFAULTS.chrome },
  }
}

/**
 * Drop the keys whose value is undefined before merging a patch.
 *
 * A patch assembled field by field from optional inputs — `{ color: in.color,
 * scale: in.scale }` — carries an explicit undefined for everything the caller
 * left out, and spreading that over the current state blanks values nobody
 * mentioned. JSON.stringify quietly deletes them on the way through the socket,
 * so this only bites the dev console and any in-process caller: exactly the two
 * paths used while dressing the set, and the two where a mystery reset costs a
 * take.
 */
function defined<T extends object>(patch: T | undefined): Partial<T> {
  if (!patch) return {}
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(patch)) {
    if (value !== undefined) out[key] = value
  }
  return out as Partial<T>
}

type State = {
  phase: Phase
  /** 0..1 mic loudness, drives the reactor pulse. */
  level: number
  /** What JARVIS is currently reading aloud or has just said. */
  caption: string
  turns: Turn[]
  activeTool: string | null
  error: string | null
  connected: string[]
  /** Name of the speech-synthesis voice in use, shown in the HUD. */
  voice: string
  /** Why the Mac voice is standing in for Kokoro ('' when it is not). */
  voiceNote: string
  /** Transient status line during boot, e.g. the voice model download. */
  bootNote: string
  /** Which data source the bridge reports. null until it has said. */
  dataPath: DataPath | null
  /** How Jarvis hears his name: 'porcupine', 'on-device', 'cloud', 'push-to-talk' or 'pack-downloading'. */
  wake: string
  /** Blades currently open, newest last — which is also front-most. */
  blades: Blade[]
  /** The blade the user has pulled forward, or null for "the newest one". */
  focusedBlade: string | null
  /** A blade thrown to full screen, or null. */
  expandedBlade: string | null
  /** JARVIS's control over his own appearance. UI_DEFAULTS == the stock look. */
  ui: UiState

  setVoice: (v: string) => void
  setVoiceNote: (n: string) => void
  setBootNote: (n: string) => void
  setDataPath: (p: DataPath) => void
  setWake: (w: string) => void
  pushBlade: (b: Blade) => void
  closeBlade: (id: string) => void
  clearBlades: () => void
  focusBlade: (id: string | null) => void
  expandBlade: (id: string | null) => void
  setPhase: (p: Phase) => void
  setLevel: (l: number) => void
  setCaption: (c: string) => void
  setActiveTool: (t: string | null) => void
  setError: (e: string | null) => void
  setConnected: (c: string[]) => void
  pushTurn: (t: Turn) => void
  appendToLastTurn: (text: string) => void

  applyUi: (patch: UiPatch) => void
  fireEffect: (kind: UiEffect['kind']) => void
  resetUi: () => void
  clearScreen: (what: 'all' | 'panels' | 'transcript') => void
}

export const useStore = create<State>((set) => ({
  phase: 'offline',
  level: 0,
  caption: '',
  turns: [],
  activeTool: null,
  error: null,
  connected: [],
  voice: '',
  voiceNote: '',
  dataPath: null,
  wake: 'push-to-talk',
  blades: [],
  focusedBlade: null,
  expandedBlade: null,
  bootNote: '',
  ui: defaultUi(),

  setVoice: (voice) => set({ voice }),
  setVoiceNote: (voiceNote) => set({ voiceNote }),
  setBootNote: (bootNote) => set({ bootNote }),
  setDataPath: (dataPath) => set({ dataPath }),
  setWake: (wake) => set({ wake }),

  /**
   * Six is the ceiling, and it is about the stack reading as a stack: past
   * about six the ones at the back are a millimetre of edge each and the depth
   * stops meaning anything. The oldest falls off, which is also the one the
   * user has had longest to look at.
   */
  pushBlade: (blade) =>
    set((s) => {
      const next = [...s.blades.filter((b) => b.id !== blade.id), blade].slice(-6)
      // A new blade comes to the front. Leaving the old focus in place would
      // open something the user asked for and then hide it behind what they
      // were looking at before.
      return { blades: next, focusedBlade: blade.id }
    }),
  closeBlade: (id) =>
    set((s) => ({
      blades: s.blades.filter((b) => b.id !== id),
      focusedBlade: s.focusedBlade === id ? null : s.focusedBlade,
      expandedBlade: s.expandedBlade === id ? null : s.expandedBlade,
    })),
  // Same contract as panels: 'turn' blades go when the user speaks again,
  // 'sticky' ones stay until something replaces them.
  clearBlades: () =>
    set((s) => {
      const kept = s.blades.filter((b) => b.hold === 'sticky')
      const alive = new Set(kept.map((b) => b.id))
      return {
        blades: kept,
        focusedBlade: s.focusedBlade && alive.has(s.focusedBlade) ? s.focusedBlade : null,
        expandedBlade: s.expandedBlade && alive.has(s.expandedBlade) ? s.expandedBlade : null,
      }
    }),
  focusBlade: (focusedBlade) => set({ focusedBlade }),
  expandBlade: (expandedBlade) => set({ expandedBlade }),
  setPhase: (phase) => set({ phase }),
  setLevel: (level) => set({ level }),
  setCaption: (caption) => set({ caption }),
  setActiveTool: (activeTool) => set({ activeTool }),
  setError: (error) => set({ error }),
  setConnected: (connected) => set({ connected }),
  pushTurn: (turn) => set((s) => ({ turns: [...s.turns.slice(-40), turn] })),
  appendToLastTurn: (text) =>
    set((s) => {
      const turns = [...s.turns]
      const last = turns[turns.length - 1]
      if (!last || last.role !== 'jarvis') return {}
      turns[turns.length - 1] = { ...last, text: last.text + text }
      return { turns }
    }),

  // Deep on purpose. "Make the reactor red" arrives as a patch touching only
  // reactor.color, and a shallow merge would take the scale, spin and style
  // with it — one instruction silently undoing three earlier ones. Note the
  // `=== undefined` tests rather than `??`: null is a real value here (it means
  // "go back to following the phase"), and only an absent key means "leave it".
  applyUi: (patch) =>
    set((s) => ({
      ui: {
        ...s.ui,
        accent: patch.accent === undefined ? s.ui.accent : patch.accent,
        background: patch.background === undefined ? s.ui.background : patch.background,
        palette: { ...s.ui.palette, ...defined(patch.palette) },
        reactor: { ...s.ui.reactor, ...defined(patch.reactor) },
        chrome: { ...s.ui.chrome, ...defined(patch.chrome) },
      },
    })),
  fireEffect: (kind) =>
    set((s) => ({ ui: { ...s.ui, effect: { kind, at: Date.now() } } })),
  resetUi: () => set({ ui: defaultUi() }),
  // An explicit order outranks the sticky flag. `hold: 'sticky'` only ever
  // meant "survive the next turn boundary"; when someone says "clear the
  // screen", a card staying up because an earlier turn asked nicely reads as
  // the interface ignoring the instruction.
  clearScreen: (what) =>
    set((s) => {
      const turns = what === 'panels' ? s.turns : []
      // Blades clear with the panels. "Clear the screen" said out loud means the
      // screen, and leaving a full-height article standing while the cards
      // around it vanish is the interface arguing with the instruction.
      const blades = what === 'transcript' ? s.blades : []
      const cleared = { turns, blades, focusedBlade: null, expandedBlade: null }
      return what === 'all'
        ? { ...cleared, caption: '', activeTool: null }
        : cleared
    }),
}))

/** Colour identity per phase — shared by the 3D scene and the 2D HUD. */
/**
 * Donevia brand: pink is Jarvis himself (listening, speaking), violet is work
 * in progress (thinking, reading data). Idle states are a quiet, low pink so
 * the face never reads as an alert at rest. No cyan anywhere.
 */
export const phaseColor: Record<Phase, string> = {
  offline: '#2a2b33',
  boot: '#b9b4e8',
  dormant: '#8f8bb8',
  waking: '#e6d2ff',
  listening: '#d9b8f2',
  thinking: '#a99bff',
  tooling: '#b8a8ff',
  speaking: '#efe6ff',
}

/**
 * What colour is the interface right now.
 *
 * The 3D scene and the 2D HUD have to answer this identically — a reactor
 * glowing one colour behind a rail glowing another is the single most obvious
 * way this comes apart on camera — so the resolution order lives here once
 * instead of being reimplemented either side of the canvas boundary. A blanket
 * accent wins over a per-phase override, which wins over the built-in map.
 */
export function accentFor(phase: Phase, ui: UiState): string {
  return ui.accent ?? ui.palette[phase] ?? phaseColor[phase]
}

// Handy while dressing the scene for camera: in the dev server you can drive
// the visuals from the console without talking, e.g.
//   __jarvis.setPhase('tooling'); __jarvis.setLevel(0.8)
//   __jarvis.applyUi({ accent: '#a99bff', reactor: { style: 'wire', spin: 3 } })
//   __jarvis.fireEffect('pulse'); __jarvis.resetUi()
if (import.meta.env.DEV) {
  // Not `useStore.getState()` directly: zustand replaces the state object on
  // every set, so a captured snapshot's *actions* keep working while every
  // data field reads forever as it was at module load. `__jarvis.phase` said
  // 'offline' no matter what was on screen.
  ;(window as unknown as Record<string, unknown>).__jarvis = new Proxy(
    {} as Record<string, unknown>,
    {
      get: (_t, key) => (useStore.getState() as Record<string | symbol, unknown>)[key],
      has: (_t, key) => key in useStore.getState(),
      ownKeys: () => Reflect.ownKeys(useStore.getState()),
      getOwnPropertyDescriptor: () => ({ enumerable: true, configurable: true }),
    },
  )
}
