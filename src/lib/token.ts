/**
 * The per-launch token that lets this window talk to the bridge.
 *
 * `npm start` opens the face as http://127.0.0.1:5173/#t=<token>. The fragment
 * never leaves the browser, and no other page can read it. It is kept in
 * sessionStorage (so a reload still works) and removed from the address bar.
 * Without it the bridge refuses the socket and /config: other pages on this
 * Mac, including other local dev servers, cannot drive Jarvis.
 */

const KEY = 'donevia-jarvis.token'
const FORMAT = /^[a-f0-9]{32,64}$/

let cached: string | null | undefined

export function launchToken(): string | null {
  if (cached !== undefined) return cached
  let token: string | null = null
  const m = /(?:^#|&)t=([a-f0-9]{32,64})(?:&|$)/.exec(location.hash)
  if (m) {
    token = m[1]
    try {
      sessionStorage.setItem(KEY, token)
    } catch {
      /* storage blocked: the fragment stays the source */
    }
    try {
      history.replaceState(null, '', location.pathname + location.search)
    } catch {
      /* leave the address bar as it is */
    }
  } else {
    try {
      const saved = sessionStorage.getItem(KEY)
      if (saved && FORMAT.test(saved)) token = saved
    } catch {
      /* none */
    }
  }
  cached = token
  return token
}

/** The two subprotocols the bridge expects: its name, and the token. */
export const bridgeProtocols = (token: string) => ['donevia-jarvis', `jt.${token}`]

export const NO_TOKEN_MESSAGE =
  'This window was not opened by the launcher. Close it and double-click "Start Cortana.command" (or run npm start).'
