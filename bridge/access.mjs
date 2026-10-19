/**
 * Who may talk to the bridge.
 *
 * The bridge holds a signed-in Claude Code session that can read Eli's mail,
 * calendar, notes, CRM and HQ. Three checks keep it to the Jarvis window:
 *
 *   1. Host. Only 127.0.0.1, localhost or [::1] on the bridge's port. A page
 *      that rebinds its own domain to 127.0.0.1 sends its own Host and is
 *      refused (DNS rebinding).
 *   2. Origin. Only the face's exact origin, http://127.0.0.1:5173, plus
 *      JARVIS_ALLOWED_ORIGINS. Not http://localhost:5173: on a Mac, "localhost"
 *      tries [::1] first, where another project's `npm run dev` may be
 *      listening on the same port. Other local dev servers (5174, 4173...)
 *      are not trusted either.
 *   3. A per-launch token. `npm start` makes a random token, gives it to the
 *      bridge in the environment and to the face in the URL fragment (which
 *      never leaves the browser). The face presents it as a WebSocket
 *      subprotocol and as a header on /config. Without it there is no socket
 *      and no /config.
 *
 * Everything here is pure so test/access.test.mjs covers it.
 */
import { randomBytes, timingSafeEqual } from 'node:crypto'

/** The subprotocol the face asks for and the bridge selects. */
export const PROTOCOL = 'donevia-jarvis'
/** The token travels as a second subprotocol: "jt." + 32 hex characters. */
export const TOKEN_PREFIX = 'jt.'
export const TOKEN_HEADER = 'x-jarvis-token'
export const TOKEN_FORMAT = /^[a-f0-9]{32,64}$/

export const newToken = () => randomBytes(16).toString('hex')

export const FACE_PORT = 5173

/** The exact page origins allowed to use the bridge. */
export function faceOrigins({ facePort = FACE_PORT, extra = [] } = {}) {
  return new Set([
    `http://127.0.0.1:${facePort}`,
    ...extra.map((o) => String(o).trim().replace(/\/+$/, '')).filter(Boolean),
  ])
}

export function originAllowed(origin, allowed, { allowNoOrigin = false } = {}) {
  if (!origin) return allowNoOrigin
  return allowed.has(String(origin).replace(/\/+$/, ''))
}

/** Host header must name the loopback interface on our own port. */
export function hostAllowed(host, port) {
  if (typeof host !== 'string') return false
  const h = host.trim().toLowerCase()
  return h === `127.0.0.1:${port}` || h === `localhost:${port}` || h === `[::1]:${port}`
}

/** Constant-time comparison; false for anything malformed. */
export function tokenMatches(given, expected) {
  if (typeof given !== 'string' || typeof expected !== 'string') return false
  if (!TOKEN_FORMAT.test(given) || !TOKEN_FORMAT.test(expected)) return false
  const a = Buffer.from(given)
  const b = Buffer.from(expected)
  return a.length === b.length && timingSafeEqual(a, b)
}

/** The token from a Sec-WebSocket-Protocol header ("donevia-jarvis, jt.abc..."). */
export function tokenFromProtocols(header) {
  for (const p of String(header ?? '').split(',')) {
    const v = p.trim()
    if (v.startsWith(TOKEN_PREFIX)) return v.slice(TOKEN_PREFIX.length)
  }
  return null
}
