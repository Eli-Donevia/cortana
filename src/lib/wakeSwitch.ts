import { useStore } from '../store'
import { diag, setWakeWordEnabled, wakeWordEnabled } from './voice'

/**
 * The wake-word switch, shared by the W key, the footer toggle and the
 * "stop listening for your name" command. Off means push-to-talk only: the
 * recogniser stops while she is idle and Space (or a click) starts a turn.
 */
export const WAKE_OFF = 'wake-off'

/** What the HUD should show for the wake mode, given the switch. */
export const shownWake = (mode: string) => (wakeWordEnabled() ? mode : WAKE_OFF)

export function setWakeWord(on: boolean): boolean {
  setWakeWordEnabled(on)
  useStore.getState().setWake(shownWake(diag.wake))
  return on
}

export const toggleWakeWord = () => setWakeWord(!wakeWordEnabled())

export { wakeCommand } from './wake'
