/**
 * Donevia Jarvis — build-time configuration.
 *
 * Almost everything is a runtime setting now: the bridge reads the settings file and
 * the face asks it for /config at boot (see src/lib/runtime.ts). The only thing
 * the face must know before it can ask is where the bridge is.
 */

function str(raw: unknown): string | undefined {
  const value = typeof raw === 'string' ? raw.trim() : ''
  return value === '' ? undefined : value
}

/** Where the bridge listens. Keep the port in step with JARVIS_BRIDGE_PORT. */
export const BRIDGE_WS_URL = str(import.meta.env.VITE_BRIDGE_URL) ?? 'ws://127.0.0.1:8787'
export const BRIDGE_HTTP_URL = BRIDGE_WS_URL.replace(/^ws/, 'http')
