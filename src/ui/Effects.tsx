import { useEffect, useState } from 'react'
import { useReducedMotion } from 'framer-motion'
import { useStore, type UiEffect } from '../store'

/**
 * One-shot flourishes Jarvis can fire with ui_effect: a soft pulse from the
 * reactor, or a single slow scan line. Upstream's glitch, shake and flash are
 * gone; HQ's rules allow nothing that flashes more than three times a second,
 * and a chief of staff does not need a screen shake.
 */
const DURATION: Record<UiEffect['kind'], number> = { pulse: 1100, scan: 1200 }

export function Effects() {
  const effect = useStore((s) => s.ui.effect)
  const reduced = useReducedMotion()
  const [live, setLive] = useState<UiEffect | null>(null)

  const kind = effect?.kind
  const at = effect?.at ?? 0

  useEffect(() => {
    if (!kind || reduced) return
    setLive({ kind, at })
    const done = setTimeout(() => setLive(null), DURATION[kind] ?? 900)
    return () => clearTimeout(done)
  }, [kind, at, reduced])

  if (!live) return null

  return (
    <div className="fx" aria-hidden="true">
      <div key={`${live.kind}-${live.at}`} className={`fx-play fx-${live.kind}`}>
        {live.kind === 'pulse' && (
          <>
            <span className="fx-wave" />
            <span className="fx-wave" />
          </>
        )}
      </div>
    </div>
  )
}
