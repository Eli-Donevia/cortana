import { memo, useMemo } from 'react'
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion'
import { useStore, type Blade } from '../store'
import { sanitisePanelHtml } from './sanitise'

/**
 * Cards Jarvis puts on screen with the `display` tool.
 *
 * Donevia fork: text cards only. Upstream's articles, images, video, camera
 * and hand-gesture drag are gone, so there is nothing here that can load a
 * remote resource. A card is a title, a sanitised body and an accent: pink by
 * default, violet for in-progress, amber for due soon, red for late, mint for
 * done (HQ SPEC colour meanings).
 *
 * Newest first, at most three on screen; older ones stay in the store until
 * the next turn clears them. Click a card to bring it forward, the corner
 * button to widen it, the cross to close it.
 */

const Body = memo(function Body({ html }: { html: string }) {
  const clean = useMemo(() => sanitisePanelHtml(html), [html])
  return <div className="bl-markup" dangerouslySetInnerHTML={{ __html: clean }} />
})

function Card({ blade, index }: { blade: Blade; index: number }) {
  const reduced = useReducedMotion()
  const expanded = useStore((s) => s.expandedBlade === blade.id)
  const close = useStore((s) => s.closeBlade)
  const expand = useStore((s) => s.expandBlade)
  const focus = useStore((s) => s.focusBlade)

  return (
    <motion.section
      layout={!reduced}
      className={`bl bl-${blade.size} bl-accent-${blade.accent ?? 'default'}${expanded ? ' bl-expanded' : ''}`}
      style={{ zIndex: 10 - index }}
      initial={reduced ? { opacity: 0 } : { opacity: 0, x: 24 }}
      animate={{ opacity: index > 2 ? 0 : 1 - index * 0.18, x: 0 }}
      exit={reduced ? { opacity: 0 } : { opacity: 0, x: 24 }}
      transition={{ type: 'spring', stiffness: 260, damping: 30 }}
      onClick={() => focus(blade.id)}
      aria-label={blade.title}
    >
      <header className="bl-head">
        <span className="bl-title">{blade.title}</span>
        <span className="bl-acts">
          <button
            className="bl-btn"
            title={expanded ? 'Shrink' : 'Widen'}
            aria-label={expanded ? 'Shrink card' : 'Widen card'}
            onClick={(e) => {
              e.stopPropagation()
              expand(expanded ? null : blade.id)
            }}
          >
            {expanded ? '–' : '+'}
          </button>
          <button
            className="bl-btn"
            title="Close"
            aria-label="Close card"
            onClick={(e) => {
              e.stopPropagation()
              close(blade.id)
            }}
          >
            ×
          </button>
        </span>
      </header>
      <div className="bl-body">
        {blade.html ? <Body html={blade.html} /> : <p className="bl-note">Nothing to show.</p>}
      </div>
    </motion.section>
  )
}

export function Blades() {
  const blades = useStore((s) => s.blades)
  const focused = useStore((s) => s.focusedBlade)
  const expanded = useStore((s) => s.expandedBlade)

  // Focused card first, then newest to oldest.
  const ordered = useMemo(() => {
    const rev = [...blades].reverse()
    const lead = expanded ?? focused
    if (!lead) return rev
    const hit = rev.find((b) => b.id === lead)
    return hit ? [hit, ...rev.filter((b) => b.id !== lead)] : rev
  }, [blades, focused, expanded])

  return (
    <div className={`blades${expanded ? ' blades-full' : ''}`} aria-live="polite">
      <AnimatePresence initial={false}>
        {(expanded ? ordered.slice(0, 1) : ordered.slice(0, 3)).map((b, i) => (
          <Card key={b.id} blade={b} index={i} />
        ))}
      </AnimatePresence>
    </div>
  )
}
