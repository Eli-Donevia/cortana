import { useStore } from '../store'

/**
 * The start gate. Chrome will not play audio or open the microphone until the
 * page has been clicked, so the first screen is a single button.
 *
 * A plain conditional, not AnimatePresence: upstream found that an exiting
 * full-screen button could stay in the DOM at opacity 0 and swallow every
 * click after it. Nothing here animates out, so nothing can be stranded.
 */
export function Ignition({ onStart }: { onStart: () => void }) {
  const phase = useStore((s) => s.phase)
  const error = useStore((s) => s.error)
  if (phase !== 'offline') return null

  return (
    <button className="ignition" onClick={onStart} autoFocus>
      <span className="ignition-mark">
        <span className="orb-dot orb-dot-ignition" aria-hidden="true" />
        <span className="ignition-ring" />
      </span>
      <span className="ignition-label">
        <span className="ignition-word">CORTANA</span>
        <span className="ignition-sub">Click or press Space to start</span>
        {error && <span className="ignition-err">{error}</span>}
      </span>
    </button>
  )
}
