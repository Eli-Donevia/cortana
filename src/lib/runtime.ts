import { BRIDGE_HTTP_URL } from '../config'
import { launchToken } from './token'
import type { KokoroVoiceId } from './kokoroVoices'

/**
 * Settings the face reads from the bridge at boot (GET /config).
 *
 * They live in the settings file next to the bridge rather than in the Vite bundle,
 * so changing the voice or adding a Picovoice key needs a restart, not a
 * rebuild, and no key is ever compiled into JavaScript.
 */
export type Runtime = {
  version: string
  hqUrl: string
  tts: {
    engine: 'kokoro' | 'system'
    /** From the settings file. A pick made with V overrides it (kokoro.ts). */
    voice: KokoroVoiceId
    device: 'auto' | 'webgpu' | 'wasm'
  }
  wake: {
    /** auto: on-device recognition if Chrome has it, else push-to-talk. */
    mode: 'auto' | 'on-device' | 'cloud' | 'off'
    porcupineKey: string | null
  }
}

const DEFAULTS: Runtime = {
  version: '',
  hqUrl: '',
  tts: { engine: 'kokoro', voice: 'bf_emma', device: 'auto' },
  wake: { mode: 'auto', porcupineKey: null },
}

let current: Runtime = DEFAULTS
let loaded = false

export const runtime = (): Runtime => current
export const runtimeLoaded = () => loaded

/** Never throws: an unreachable bridge leaves the defaults in place. */
export async function loadRuntime(): Promise<Runtime> {
  try {
    const token = launchToken()
    if (!token) return current
    const res = await fetch(`${BRIDGE_HTTP_URL}/config`, {
      headers: { 'x-jarvis-token': token },
      signal: AbortSignal.timeout(3000),
    })
    if (res.ok) {
      const body = (await res.json()) as Partial<Runtime>
      current = {
        ...DEFAULTS,
        ...body,
        tts: { ...DEFAULTS.tts, ...(body.tts ?? {}) },
        wake: { ...DEFAULTS.wake, ...(body.wake ?? {}) },
      }
      loaded = true
    }
  } catch {
    /* bridge down: defaults */
  }
  return current
}
